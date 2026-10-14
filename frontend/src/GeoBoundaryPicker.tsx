import { useEffect, useMemo, useState } from 'react'

type BoundaryLevel = `ADM${0 | 1 | 2 | 3 | 4 | 5}`
type Position = [number, number, ...number[]]
type BoundaryFeature = {
  properties: { shapeID: string; shapeName: string }
  geometry: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: Position[][] | Position[][][]
  }
}
type BoundaryCollection = { features: BoundaryFeature[] }
type CountryFeature = {
  properties: {
    ADMIN: string
    ADM0_A3: string
    ADM0_A3_EH?: string
    CONTINENT: string
  }
  geometry: BoundaryFeature['geometry']
}
type CountryCollection = { features: CountryFeature[] }
type BoundaryMetadata = {
  boundaryCanonical: string
  boundaryLicense?: string
  boundaryName: string
  boundaryISO: string
  boundaryType: BoundaryLevel
  simplifiedGeometryGeoJSON: string
}
type AvailableLevel = {
  level: BoundaryLevel
  canonical: string
  boundaryLicense: string
  simplifiedGeometryGeoJSON: string
}

export type GeoBoundarySelection = {
  provider: 'geoBoundaries' | 'naturalEarth'
  boundaryId: string
  boundaryName: string
  boundaryLevel: 'CONTINENT' | 'COUNTRY' | BoundaryLevel
  boundaryCanonical?: string
  countryCode?: string
  countryName?: string
  continent?: string
}

const continents = [
  'Africa',
  'Antarctica',
  'Asia',
  'Europe',
  'North America',
  'Oceania',
  'South America',
]
const maximumAdministrativeLevel = 5
const geoBoundariesApi = 'https://www.geoboundaries.org/api/current/gbOpen'

export function GeoBoundaryPicker({
  value,
  onChange,
}: {
  value?: GeoBoundarySelection
  onChange: (selection: GeoBoundarySelection | undefined) => void
}) {
  const [world, setWorld] = useState<CountryCollection>()
  const [worldError, setWorldError] = useState('')
  const [continent, setContinent] = useState(value?.continent ?? '')
  const [countryCode, setCountryCode] = useState(value?.countryCode ?? '')
  const [levels, setLevels] = useState<AvailableLevel[]>([])
  const [level, setLevel] = useState<BoundaryLevel>(
    value && isAdministrativeLevel(value.boundaryLevel) ? value.boundaryLevel : 'ADM1',
  )
  const [data, setData] = useState<BoundaryCollection>()
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loadingLevels, setLoadingLevels] = useState(false)
  const [loadingBoundaries, setLoadingBoundaries] = useState(false)

  useEffect(() => {
    let current = true
    void fetch('/data/world-countries.geojson')
      .then(async (response) => {
        if (!response.ok) throw new Error(`World map request failed (${response.status})`)
        return await response.json() as CountryCollection
      })
      .then((collection) => {
        if (current) setWorld(collection)
      })
      .catch((reason: unknown) => {
        if (current) setWorldError(errorMessage(reason))
      })
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!value) return
    setContinent(value.continent ?? '')
    setCountryCode(value.countryCode ?? '')
    setLevel(isAdministrativeLevel(value.boundaryLevel) ? value.boundaryLevel : 'ADM1')
    setSearch(isAdministrativeLevel(value.boundaryLevel) ? value.boundaryName : '')
  }, [value])

  const countries = useMemo(() => (world?.features ?? [])
    .filter((feature) => isCountryFeature(feature))
    .sort((left, right) => left.properties.ADMIN.localeCompare(right.properties.ADMIN)), [world])
  const visibleCountries = continent
    ? countries.filter((feature) => feature.properties.CONTINENT === continent)
    : countries
  const selectedCountry = countries.find((feature) => countryIso(feature) === countryCode)
  const selectedCountryName = selectedCountry?.properties.ADMIN
  const selectedContinent = selectedCountry?.properties.CONTINENT ?? continent
  const levelMetadata = levels.find((item) => item.level === level)
  const selectedAdministrativeBoundary = value?.boundaryLevel === level &&
    value.countryCode === countryCode
  const features = useMemo(() => (data?.features ?? []).filter((feature) =>
    typeof feature.properties?.shapeID === 'string' &&
    typeof feature.properties?.shapeName === 'string'), [data])
  const worldProjection = useMemo(() => createProjection(countries), [countries])
  const selectedId = value?.boundaryLevel === level &&
    value.countryCode === countryCode ? value.boundaryId : undefined
  const displayedFeatures = selectedId
    ? features.filter((feature) => feature.properties.shapeID === selectedId)
    : features
  const boundaryProjection = useMemo(() => createProjection(displayedFeatures), [displayedFeatures])
  const matching = useMemo(() => features
    .filter((feature) => feature.properties.shapeName.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, 30), [features, search])

  useEffect(() => {
    if (!countryCode) {
      setLevels([])
      setData(undefined)
      return
    }
    const controller = new AbortController()
    setLoadingLevels(true)
    setError('')
    setLevels([])
    setData(undefined)
    void loadAvailableLevels(countryCode, controller.signal)
      .then((available) => {
        if (controller.signal.aborted) return
        setLevels(available)
        if (available.length && !available.some((item) => item.level === level)) {
          setLevel(available.find((item) => item.level === 'ADM1')?.level ?? available[0].level)
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingLevels(false)
      })
    return () => controller.abort()
  }, [countryCode])

  useEffect(() => {
    if (!countryCode || !levelMetadata) {
      setData(undefined)
      return
    }
    const controller = new AbortController()
    setLoadingBoundaries(true)
    setError('')
    setData(undefined)
    void fetch(levelMetadata.simplifiedGeometryGeoJSON, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Boundary data request failed (${response.status})`)
        return await response.json() as BoundaryCollection
      })
      .then((collection) => {
        if (!controller.signal.aborted) setData(collection)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingBoundaries(false)
      })
    return () => controller.abort()
  }, [countryCode, level, levelMetadata])

  function chooseContinent(nextContinent: string) {
    setContinent(nextContinent)
    setCountryCode('')
    setSearch('')
    setLevel('ADM1')
    onChange(undefined)
  }

  function chooseCountry(feature: CountryFeature) {
    const code = countryIso(feature)
    if (!code) return
    setContinent(feature.properties.CONTINENT)
    setCountryCode(code)
    setSearch('')
    setLevel('ADM1')
    onChange(undefined)
  }

  function changeCountry() {
    setCountryCode('')
    setLevels([])
    setData(undefined)
    setSearch('')
    onChange(undefined)
  }

  function selectBoundary(feature: BoundaryFeature) {
    if (!selectedCountryName || !countryCode || !selectedContinent || !levelMetadata) return
    setSearch(feature.properties.shapeName)
    onChange({
      provider: 'geoBoundaries',
      boundaryId: feature.properties.shapeID,
      boundaryName: feature.properties.shapeName,
      boundaryLevel: level,
      boundaryCanonical: levelMetadata.canonical,
      countryCode,
      countryName: selectedCountryName,
      continent: selectedContinent,
    })
  }

  function selectContinent() {
    if (!continent) return
    onChange({
      provider: 'naturalEarth',
      boundaryId: `natural-earth:continent:${continent}`,
      boundaryName: continent,
      boundaryLevel: 'CONTINENT',
      continent,
    })
  }

  function selectCountry() {
    if (!selectedCountryName || !countryCode || !selectedContinent) return
    onChange({
      provider: 'naturalEarth',
      boundaryId: `natural-earth:country:${countryCode}`,
      boundaryName: selectedCountryName,
      boundaryLevel: 'COUNTRY',
      countryCode,
      countryName: selectedCountryName,
      continent: selectedContinent,
    })
  }

  return (
    <section className="boundary-picker">
      <p className="boundary-intro">Select the level that matches this leader's area. You can use a continent, a whole country, or a smaller administrative unit.</p>
      <div className="boundary-step">
        {!continent && (
          <label className="form-field">
            <span>Continent</span>
            <select value={continent} onChange={(event) => chooseContinent(event.target.value)}>
              <option value="">Choose a continent</option>
              {continents.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        )}
        {continent && !countryCode && (
          <>
            <label className="form-field">
              <span>Country</span>
              <select
                value={countryCode}
                onChange={(event) => {
                  const feature = countries.find((item) => countryIso(item) === event.target.value)
                  if (feature) chooseCountry(feature)
                }}
              >
                <option value="">Choose a country</option>
                {visibleCountries.map((feature) => {
                  const code = countryIso(feature)
                  return code ? <option key={code} value={code}>{feature.properties.ADMIN}</option> : null
                })}
              </select>
            </label>
            <button type="button" className="text-button" onClick={() => chooseContinent('')}>Change continent</button>
          </>
        )}
        {countryCode && levelMetadata && (
          <>
            <label className="form-field">
              <span>{singularAdministrativeName(levelMetadata.canonical)}</span>
              <input
                className="boundary-search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  if (selectedAdministrativeBoundary) onChange(undefined)
                }}
                placeholder={`Search ${singularAdministrativeName(levelMetadata.canonical).toLowerCase()} by name`}
                aria-label={`Search ${singularAdministrativeName(levelMetadata.canonical).toLowerCase()}`}
              />
            </label>
            <div className="boundary-step-actions">
              <button type="button" className="text-button" onClick={changeCountry}>Change country</button>
              <button type="button" className="text-button" onClick={() => chooseContinent('')}>Change continent</button>
            </div>
          </>
        )}
      </div>
      {continent && !countryCode && (
        <button type="button" className="secondary-button geography-capture" onClick={selectContinent}>
          Use all of {continent} as the jurisdiction
        </button>
      )}
      {countryCode && selectedCountryName && !selectedAdministrativeBoundary && (
        <button type="button" className="secondary-button geography-capture" onClick={selectCountry}>
          Use all of {selectedCountryName} as the jurisdiction
        </button>
      )}
      {countryCode && selectedAdministrativeBoundary && value && (
        <button type="button" className="secondary-button geography-capture" onClick={() => onChange(value)}>
          Use all of {value.boundaryName} as the jurisdiction
        </button>
      )}
      {countryCode && levels.length > 1 && (
        <div className="boundary-level-options" role="group" aria-label="Administrative unit level">
          {levels.map((item) => (
            <button
              key={item.level}
              type="button"
              aria-pressed={level === item.level}
              className={level === item.level ? 'boundary-level-option selected' : 'boundary-level-option'}
              onClick={() => {
                setLevel(item.level)
                setSearch('')
                onChange(undefined)
              }}
            >
              {singularAdministrativeName(item.canonical)}
            </button>
          ))}
        </div>
      )}
      {worldError && <div className="inline-error" role="alert">{worldError}</div>}
      {world && worldProjection && !countryCode && (
        <>
          <div className="boundary-map global-boundary-map" role="group" aria-label="World country map">
            <svg viewBox="0 0 500 260" role="img" aria-label="World map; choose a continent and country">
              {countries.map((feature, index) => {
                const isInContinent = !continent || feature.properties.CONTINENT === continent
                const isSelected = countryIso(feature) === countryCode
                return (
                  <path
                    key={`${countryIso(feature) ?? feature.properties.ADMIN}-${index}`}
                    d={featurePath(feature, worldProjection)}
                    className={`boundary-shape country-shape${isInContinent ? '' : ' muted'}${isSelected ? ' selected' : ''}`}
                    tabIndex={0}
                    role="button"
                    aria-label={`${feature.properties.ADMIN}, ${feature.properties.CONTINENT}`}
                    onClick={() => {
                      if (continent !== feature.properties.CONTINENT) chooseContinent(feature.properties.CONTINENT)
                      else chooseCountry(feature)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        if (continent !== feature.properties.CONTINENT) chooseContinent(feature.properties.CONTINENT)
                        else chooseCountry(feature)
                      }
                    }}
                  >
                    <title>{feature.properties.ADMIN} · {feature.properties.CONTINENT}</title>
                  </path>
                )
              })}
            </svg>
          </div>
          <small className="boundary-attribution">Country outlines: Natural Earth 1:110m cultural vectors, public domain. Click a country to select its continent, then click it again to open its administrative levels.</small>
        </>
      )}

      {countryCode && loadingLevels && <div className="loading-state"><span className="spinner" /> Finding available administrative levels…</div>}
      {countryCode && !loadingLevels && !levels.length && !error && (
        <p className="muted-copy">No open administrative boundary levels are available for this country.</p>
      )}
      {countryCode && loadingBoundaries && <div className="loading-state"><span className="spinner" /> Loading {selectedCountryName} {levelMetadata?.canonical ?? level} boundaries…</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {data && boundaryProjection && levelMetadata && (
        <>
          <p className="boundary-selection">{selectedContinent} / {selectedCountryName} / {levelMetadata.canonical}</p>
          <div className="boundary-map" role="group" aria-label={`Select a ${levelMetadata.canonical} boundary`}>
            <svg viewBox="0 0 500 360" role="img" aria-label={`${selectedCountryName} ${levelMetadata.canonical} boundaries`}>
              {displayedFeatures.map((feature) => (
                <path
                  key={feature.properties.shapeID}
                  d={featurePath(feature, boundaryProjection)}
                  className={selectedId === feature.properties.shapeID ? 'boundary-shape selected' : 'boundary-shape'}
                  tabIndex={0}
                  role="button"
                  aria-label={feature.properties.shapeName}
                  onClick={() => selectBoundary(feature)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      selectBoundary(feature)
                    }
                  }}
                >
                  <title>{feature.properties.shapeName}</title>
                </path>
              ))}
            </svg>
          </div>
          {selectedId
            ? <button type="button" className="text-button" onClick={() => { setSearch(''); onChange(undefined) }}>Choose a different {singularAdministrativeName(levelMetadata.canonical).toLowerCase()}</button>
            : (
              <div className="boundary-results" aria-label={`Matching ${levelMetadata.canonical}`}>
                {matching.map((feature) => (
                  <button
                    type="button"
                    key={feature.properties.shapeID}
                    className="boundary-result"
                    onClick={() => selectBoundary(feature)}
                  >
                    {feature.properties.shapeName}
                  </button>
                ))}
                {!matching.length && <span className="muted-copy">No matching boundaries.</span>}
              </div>
            )}
          {selectedAdministrativeBoundary && value && (
            <p className="boundary-selection">Selected: <strong>{value.boundaryName}, {value.countryName}</strong></p>
          )}
          <small className="boundary-attribution">
            Administrative boundaries from <a href={`${geoBoundariesApi}/${countryCode}/${level}/`} target="_blank" rel="noreferrer">geoBoundaries</a>
            {levelMetadata.boundaryLicense ? ` · ${levelMetadata.boundaryLicense}` : ''}. Data loads on demand for the selected country and level.
          </small>
        </>
      )}
      {value && <button type="button" className="text-button" onClick={() => onChange(undefined)}>Clear selected boundary</button>}
    </section>
  )
}

async function loadAvailableLevels(countryCode: string, signal: AbortSignal): Promise<AvailableLevel[]> {
  if (!/^[A-Z]{3}$/.test(countryCode)) throw new Error('Invalid country code for boundary lookup')
  const response = await fetch(`${geoBoundariesApi}/${countryCode}/ALL/`, { signal })
  if (!response.ok) {
    throw new Error(`Could not load ${countryCode} boundary metadata (${response.status})`)
  }
  const metadata = await response.json() as BoundaryMetadata[]
  if (!Array.isArray(metadata)) {
    throw new Error(`geoBoundaries returned invalid boundary metadata for ${countryCode}`)
  }

  return metadata
    .filter(({ boundaryType }) => {
      const match = /^ADM([1-5])$/.exec(boundaryType)
      return Boolean(match && Number(match[1]) <= maximumAdministrativeLevel)
    })
    .map((item) => {
      const { boundaryType: level } = item
      if (typeof item.boundaryCanonical !== 'string' || !item.boundaryCanonical ||
        typeof item.simplifiedGeometryGeoJSON !== 'string') {
        throw new Error(`geoBoundaries returned invalid metadata for ${countryCode} ${level}`)
      }
      return {
        level,
        canonical: item.boundaryCanonical,
        boundaryLicense: item.boundaryLicense ?? '',
        simplifiedGeometryGeoJSON: mediaGeometryUrl(item.simplifiedGeometryGeoJSON, countryCode, level),
      }
    })
    .sort((left, right) => Number(left.level.slice(3)) - Number(right.level.slice(3)))
}

function mediaGeometryUrl(source: string, countryCode: string, level: BoundaryLevel): string {
  const url = new URL(source)
  const match = /^\/wmgeolab\/geoBoundaries\/raw\/([A-Za-z0-9._-]+)\/releaseData\/gbOpen\/([A-Z]{3})\/(ADM[0-5])\/([^/]+\.geojson)$/.exec(url.pathname)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match ||
    match[2] !== countryCode || match[3] !== level) {
    throw new Error(`geoBoundaries returned an unsupported geometry URL for ${countryCode} ${level}`)
  }
  const [, release, , , filename] = match
  return `https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/${release}/releaseData/gbOpen/${countryCode}/${level}/${filename}`
}

function isCountryFeature(feature: CountryFeature): boolean {
  return typeof feature.properties?.ADMIN === 'string' &&
    typeof feature.properties?.CONTINENT === 'string' &&
    Boolean(countryIso(feature)) &&
    (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')
}

function countryIso(feature: CountryFeature): string | undefined {
  const code = feature.properties?.ADM0_A3_EH ?? feature.properties?.ADM0_A3
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code) && code !== '-99'
    ? code
    : undefined
}

type Projection = (longitude: number, latitude: number) => [number, number]

function createProjection(features: Array<CountryFeature | BoundaryFeature>): Projection | undefined {
  let minLongitude = Infinity
  let maxLongitude = -Infinity
  let minLatitude = Infinity
  let maxLatitude = -Infinity
  for (const feature of features) {
    visitPositions(feature, ([longitude, latitude]) => {
      minLongitude = Math.min(minLongitude, longitude)
      maxLongitude = Math.max(maxLongitude, longitude)
      minLatitude = Math.min(minLatitude, latitude)
      maxLatitude = Math.max(maxLatitude, latitude)
    })
  }
  if (![minLongitude, maxLongitude, minLatitude, maxLatitude].every(Number.isFinite) ||
    minLongitude === maxLongitude || minLatitude === maxLatitude) return undefined
  const width = maxLongitude - minLongitude
  const height = maxLatitude - minLatitude
  const scale = Math.min(450 / width, 320 / height)
  const drawnWidth = width * scale
  const drawnHeight = height * scale
  const offsetX = (500 - drawnWidth) / 2
  const offsetY = (360 - drawnHeight) / 2
  return (longitude, latitude) => [
    offsetX + (longitude - minLongitude) * scale,
    offsetY + (maxLatitude - latitude) * scale,
  ]
}

function featurePath(feature: CountryFeature | BoundaryFeature, project: Projection): string {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates as Position[][]]
    : feature.geometry.coordinates as Position[][][]
  return polygons.flatMap((rings) => rings.map((ring) => {
    if (!ring.length) return ''
    const points = ring.map(([longitude, latitude]) => project(longitude, latitude))
    return `M${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z`
  })).join('')
}

function visitPositions(
  feature: CountryFeature | BoundaryFeature,
  visit: (position: Position) => void,
): void {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates as Position[][]]
    : feature.geometry.coordinates as Position[][][]
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const position of ring) {
        if (Number.isFinite(position[0]) && Number.isFinite(position[1])) visit(position)
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load boundary data'
}

function isAdministrativeLevel(level: GeoBoundarySelection['boundaryLevel']): level is BoundaryLevel {
  return /^ADM[0-5]$/.test(level)
}

function singularAdministrativeName(canonical: string): string {
  const trimmed = canonical.trim()
  if (/ies$/i.test(trimmed)) return `${trimmed.slice(0, -3)}y`
  if (/s$/i.test(trimmed) && !/ss$/i.test(trimmed)) return trimmed.slice(0, -1)
  return trimmed
}
