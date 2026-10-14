# Juu

Juu is a standalone, pluggable business performance platform. Companies send
operational events from their existing systems to Juu and use a private
dashboard to compare performance with targets, explore trends by time and
geography, and identify areas at risk.

NiSenti will be Juu's first integration and validation case. The platform is
intended to support other businesses as well, without requiring their
end-users to interact with Juu.

Juu is the product's display brand. The deployed AWS resources, Cognito group
`UppyExecutive`, API environment variable `VITE_UPPY_API_URL`, and integration
header `x-uppy-api-key`, CDK stack name `UppyBackendStack`, and AWS Amplify app
name `Uppy` retain their existing identifiers for compatibility.
This project has not performed a trademark, company-name, or domain availability
search for Juu.

## Product direction

- Let each company define its own products, business entities, locations,
  metrics, and targets.
- Provide an API and integration credentials so a company's backend can submit
  relevant events when its existing transactions or operations occur.
- Show actuals against targets across configurable time periods and
  geographies, including maps, trends, and early warnings when targets are at
  risk.
- Show deviations and trends for individual products, as well as combined
  views that compare all products in one graph.
- Provide cluster or grouping views, where supported by the data, to help users
  understand which products behave similarly and what those groupings mean.
- Let each company choose what its map visualizes and what each dot, cluster, or
  region value represents, such as transaction volume, active users, revenue,
  or profit.
- Keep each company's data and dashboard private to that company.
- Provide a separate Juu Executive workspace for platform operators to
  onboard companies, invite company admins, and review or manage company
  profiles under explicit platform policies.

## Platform and company roles

- Juu Executives are platform-level operators. They use the same Juu sign-in
  service but see an executive dashboard, not a company workspace by default.
- Company admins are scoped to one company and can manage that company's
  configuration and reports only.
- Company leaders receive separate Cognito accounts with a trusted company
  assignment and organization-unit assignment. Their performance endpoints
  return only events belonging to their unit and active descendants; a leader
  cannot choose a different company or grant themselves another unit.
- Cognito groups identify these roles (`UppyExecutive`, `CompanyAdmin`, and
  `CompanyLeader`), but a Cognito group is not a self-service setting. A user
  must never be able to add themselves to one of these groups, set their own
  company claim, or grant themselves platform privileges.
- A person can create an account through the sign-up form, but that account
  receives no Juu role or company assignment. The AWS account operator
  explicitly adds the first executive to `UppyExecutive` in Cognito. After
  signing out and back in, that executive can onboard companies and invite
  company admins from the executive dashboard.
- Executive operations should be explicit and auditable. Initial platform
  controls should include company creation and status/review controls, admin
  invitations, and the ability to suspend or reactivate a company. Company
  suspensions must block new ingestion and admin access without deleting
  company data. Broader profile checks and enforcement rules can be added as
  their policies are defined.
- Executive authorization must use dedicated backend routes and checks for
  the `UppyExecutive` claim. It must not be implemented by allowing the
  executive group through tenant-admin routes or by accepting a company ID
  from a caller as proof of authority. Company admins remain restricted to
  their own trusted `custom:company_id`.

For NiSenti, the initial scope to explore includes profit and operational
performance across NiSenti Ndogo, chamas, superagents, transporters, COMB
contractors, and other products, including their counts, locations, and
contribution to targets.

## Geographic analysis and privacy

- For a transaction such as a money transfer, the integration may provide the
  sender's location at the time of the event using Juu’s standard location
  field. Juu does not assume it can capture the recipient's location.
- Location is optional and depends on the partner app being able to obtain it.
  Device GPS requires the relevant app permissions and user consent; Juu
  cannot obtain a device's location merely because an event is sent.
- Juu does not need sender or recipient names, phone numbers, or other direct
  identity details to display geographic performance.
- The partnering company defines the metric shown on the map and how it is
  visualized. Examples include transaction counts, distinct active senders,
  revenue, or profit, compared across regions and time periods.
- Metrics that require distinct-user counts need either a partner-provided
  pseudonymous sender key or counts aggregated by the partner. The integration
  should provide only what is needed for the configured metrics.
- Precise locations and timestamps can still make people identifiable.
  Dashboards should favor aggregated map cells or regions over exposing
  individual transaction points.

## Performance analysis

- Graphs should show how actual performance deviates from targets over time,
  both for an individual product and across all products.
- Combined graphs should make comparisons meaningful when products use
  different units or scales. Use clearly labeled measures such as percentage
  of target, variance from target, or an explicitly normalized index instead
  of implying unlike raw values are directly comparable.
- Where there is enough comparable data, users should be able to explore
  product clusters or groups with similar performance patterns. Explain the
  basis of each grouping and provide enough context for users to understand
  what the products in a cluster have in common.
- Do not imply that a cluster or correlation explains why a product performs a
  certain way; present groupings as analysis to investigate, not as proven
  causes.

## Team hierarchy, leader targets, and jurisdictions

Companies can organize performance accountability beneath the company level.
A CEO/company administrator must define the organization's structure and
jurisdictions before the company starts adding products, events, metrics, and
targets. The CEO creates first-level units and invites their leaders. Each
leader may create only direct child units beneath their own assigned unit and
invite the next-level leader there; that pattern continues at each level. This
hierarchy is company-defined; Juu must not assume every company uses Kenya's
counties or any single fixed organization chart.
The company admin can browse every unit in a selectable reporting tree and see
the selected unit's parent, jurisdiction, and leader contact details. A team
leader gets the same view limited to their assigned unit and its active
descendants, so they can inspect their own reporting line without seeing
unrelated company teams.

Initial design direction:

- Represent the structure as company-scoped organizational units with a
  Juu-generated ID, parent-unit ID, display name, optional unit type, and
  active status. Effective-dated leader assignments are future work. Keep
  leader identities separate from units so a leader can change without
  rewriting the unit IDs already stored on events.
- Keep company-wide administration with the company admin. Give team leaders
  access only to their assigned unit and authorized descendants; every API
  must enforce this scope on the server, not rely on hidden frontend controls.
  A leader may create only an immediate child unit under their assigned unit
  and invite a leader for that child. They cannot create units elsewhere,
  invite another level directly, or change company-wide configuration.
- The CEO/company admin owns the shared product catalog, event contract, and
  metric definitions, and sets company-wide targets for products they created.
  Each leader may target only products with an active target from their direct
  manager; their leaders can then target only products they targeted. The
  server derives company, unit, and signed-in officer attribution rather than
  trusting client-supplied values.
- Allow targets to be scoped to a company, organizational unit, product,
  geography, and reporting period. Show a leader their unit and descendant
  performance, while allowing company admins to roll up results across the
  company without counting the same event twice.
- Attribute each event to an organizational unit, not directly to a person's
  name. A trusted partner backend can provide the unit ID it already knows;
  alternatively, Juu can resolve an event's authorized reporting location or
  coordinates against the effective jurisdiction assignment. Reject invalid
  cross-company unit IDs. Preserve the unit and manager assignment that applied
  when the event occurred so later reassignments do not rewrite history.
- Support two jurisdiction workflows: choose an available administrative
  area (such as a county) from search results, or draw a custom polygon for
  business-defined territories. Allow child units to inherit, subdivide, or
  explicitly receive jurisdiction from a parent. Define overlap and
  out-of-area handling before using geometry to auto-assign events; ambiguous
  matches must not silently select a leader.
- Treat a reporting location (a branch or service point) as distinct from a
  leader's jurisdiction. A business may need both: locations for operational
  reporting and organizational units for accountability.

Google Maps Platform can search for places/administrative areas and its
JavaScript Data-Driven Styling feature can display and style covered
administrative boundary features by place ID. Google's boundary coverage
varies by country and boundary type, so availability of a particular Kenyan
county boundary should be checked in its [coverage tool](https://developers.google.com/maps/documentation/javascript/dds-boundaries/coverage).
Google's boundary layer is useful for showing/selecting recognized areas, but
Juu should not assume it supplies exportable polygon geometry for server-side
point-in-polygon assignment. That assignment needs a separately licensed
boundary dataset or company-drawn geometry. Google Geocoding/Places content
has storage and attribution rules: [place IDs are exempt from caching
restrictions](https://developers.google.com/maps/documentation/geocoding/policies),
but other results must follow the applicable Google Maps terms. If Google is
used for the map/search experience, show its content on a Google Map with the
required attribution.

To control cost, keep the low-resolution global country outlines local and
load detailed administrative boundaries only after a country and level are
selected. The global outlines are Natural Earth public-domain data.
Country-level boundaries are fetched from geoBoundaries Open data on demand;
coverage, administrative names, and licenses vary by country and level. This
uses no paid map API or street-map tiles, but detailed boundary selection
requires an internet connection. Keep organization, manager, target, and
event-attribution data in the existing company-scoped backend. Custom polygon
drawing, coordinate-to-jurisdiction event attribution, and target-attainment
calculations are not implemented yet.

### Recommended low-cost first map

The CEO/company admin starts by building the first organization level.
Geographic jurisdiction is optional: the form offers it first, but a unit can
be created without one for companies or teams that are not place-bound. When
needed, the boundary picker starts with a global country map and guides the
admin through one selector at a time: continent, country, then the selected
country's administrative units. The admin can save the scope at any step:
select the whole continent for a continental leader, the whole country for a
country leader, or an administrative area for a more local leader. Continent
and country selections use stable Natural Earth identifiers; country and
continent are preserved as context on lower-level selections. The
administrative unit label comes from geoBoundaries metadata and is
shown in singular form (for example, State in the United States and County in
Kenya); deeper units such as Sub-County and Ward are offered only where that
country has data. After a country is chosen, the world map is replaced by that
country's boundaries. Selecting a local unit on the map or in search immediately
updates the selected jurisdiction, search text, map highlight, and confirmation
action; search can be edited to choose a different unit. The admin assigns the
selected geographic scope to an organization unit, then
invites a first-level leader by entering their email; full name and
international-format phone number are optional contact details. That leader
can create direct child units beneath their assigned unit and invite the
next-level leaders. Once the structure exists, the CEO or an officer may add
products to the shared company catalog. Each product is stamped server-side
with its creator's Cognito subject and available name/email; leader-created
products also record the officer's assigned unit ID. The company admin's
product creation is recorded at company level. Product creators cannot choose
or change this attribution, and product entries remain available company-wide.
The pattern repeats down the hierarchy, with every hierarchy write checked
against the leader's assigned unit on the server. Administrators can assign targets to
units. Invitations assign the trusted Cognito
`CompanyLeader` group and a server-side company/unit assignment keyed to the
Cognito subject; the leader
workspace and API limit reports to that unit and its active descendants.
Provided invitee phone numbers are stored as contact details but are not
SMS-verified or used to deliver invitations; invitations are sent by email.
Partner events may include the optional company-scoped `orgUnitId`; Juu
validates it against an active unit before storing it. Events without an
`orgUnitId` remain in company-wide reports but are excluded from unit-scoped
reports.

The local global country map uses Natural Earth 1:110m country outlines from
`frontend/public/data/world-countries.geojson` (public domain); it shows
continents and countries without a street basemap. After a country is selected,
the picker discovers its available geoBoundaries ADM levels from that
country's metadata index and downloads the simplified boundary file for the
selected level only. It uses geoBoundaries' country `ALL` index rather than
probing missing levels, and retrieves geometry from the CORS-enabled GitHub
media host referenced by geoBoundaries metadata. The level's canonical
administrative name and license are shown with the map (for example, US
states, Kenya counties, and Kenya sub-counties), and the canonical name
provides the dynamic singular selector label. Data is not all bundled with
the app, so detailed selection needs an internet connection; countries or
levels with no open dataset cannot be selected from a boundary layer. No paid
map API, tile service, or application-side proxy is required.
The previous Kenya ADM1 county (Public Domain) and ADM2 sub-county (CC BY 3.0
IGO) files remain bundled as licensed reference data. Sources and attribution
are recorded in `frontend/public/data/ATTRIBUTION.txt`.

Boundaries are currently labels and visual selectors attached to a unit. Juu
does not yet perform point-in-polygon matching, so the partner must explicitly
send the known `orgUnitId` with an event when it can safely determine the unit.
Custom drawn territories, spatial overlap resolution, historical hierarchy
snapshots, and automatic attribution are future work. Google remains optional:
using Google Places/Maps would add usage-based billing and Google display and
content-policy requirements; the current feature does not use Google.

The boundary view is free to render, but a street-map basemap is a separate
data/hosting service. OpenStreetMap data is free with attribution,
but its [community tile servers are donation-funded, best-effort, and have
usage rules](https://operations.osmfoundation.org/policies/tiles/); they are
not a guaranteed production tile service. Likewise, the public
[Nominatim search service](https://operations.osmfoundation.org/policies/nominatim/)
has a strict one-request-per-second limit and forbids client-side autocomplete.
For a near-zero map-service bill, start with county boundaries and a local
search list; add street tiles or an external geocoder only if needed, after
choosing a provider with suitable service terms. AWS hosting, storage, and
event processing still have their existing usage-based costs.

## Inputs for performance analysis

The company admin configures what Juu should measure in the company's Juu
account. The company's developers connect the existing application or
backend to Juu so relevant event facts are sent automatically. Dashboard
users choose how to view the results; end users of the partner's application
do not need to log in to or interact with Juu.

### Company admin configuration

- Company profile: display name, reporting timezone, currency where relevant,
  and the locations or organizational hierarchy used for reporting.
- Products and dimensions: product names and identifiers, optional business
  entity types and hierarchy, and the regions or locations used to group
  activity.
- Metrics: metric name and meaning, unit, whether higher or lower is better,
  aggregation method (such as sum, count, or distinct-user count), and the
  event fields or formula used to calculate it.
- For every custom event field, choose its data type (number, string, or
  boolean) and enter the human-readable display name that company users should
  see in charts, legends, filters, and data-quality messages. For example,
  the stable key `amount` could be displayed as `Transfer amount (KES)`.
- Targets: target value, metric, applicable product and geography, time period
  or effective dates, and any thresholds that determine when performance is
  at risk.
- Map and comparison preferences: the metric and geographic level to display,
  plus a comparable measure (such as percentage of target) when combining
  products with different units.
- Data and privacy choices: required event fields, location precision,
  retention period, and whether distinct-user metrics need a
  partner-generated pseudonymous identifier or partner-aggregated counts.
- Enable or disable standard event fields such as sender event-time location
  for the configured analysis; admins should not need to define a custom
  schema for common fields.

### Partner event data

For each relevant business event, the partner's system should send only the
fields needed by configured metrics. Use a standard event envelope for shared
fields and allow companies to add as many event types and custom metric inputs
as their analysis requires. Custom fields should be declared and described,
not sent as an undocumented collection of arbitrary values. Depending on the
metric, event data may include:

- A unique event identifier for duplicate detection, event type, and event
  timestamp.
- Product and relevant business-entity identifiers, plus sender event-time
  location in Juu’s standard format when needed for geographic analysis.
  The integration must obtain the location from an authorized source and
  attach it to the event; the standard field avoids inventing a partner-specific
  location schema but does not make GPS automatically available.
- Metric inputs such as transaction count, amount, fee, revenue, or cost;
  profit must not be inferred unless the partner supplies the required cost
  inputs or an agreed profit value.
- A partner-generated pseudonymous sender key only when needed to calculate
  distinct senders. Do not send names, phone numbers, or recipient identity
  for map display.
- Event status or correction information when cancellations, reversals, or
  updates need to change previously reported results.

Example contract and event:

```json
{
  "version": 1,
  "standardFields": {
    "senderLocation": "optional",
    "reportingLocation": "disabled"
  },
  "eventTypes": [
    {
      "key": "money_transfer",
      "label": "Money transfer",
      "description": "A completed money transfer",
      "productIds": ["01234567-89ab-4cde-8fab-0123456789ab"],
      "fields": [
        {
          "key": "amount",
          "label": "Transfer amount",
          "description": "Amount sent",
          "type": "number",
          "role": "measure",
          "required": true,
          "unit": "KES",
          "aggregation": "sum"
        }
      ]
    }
  ]
}
```

Each event type must be linked to at least one active company product before a
new contract can be published. An event type may be shared by multiple
products. Ingested events are rejected if their product is not linked to the
submitted event type. Older contract versions without `productIds` remain
readable for compatibility with already configured companies.

An event using that contract can include the standard sender location, the
declared custom measure, and the optional `orgUnitId` chosen by the partner
backend. `productId`, `locationId`, and `orgUnitId` (when provided) are
Juu-generated resource IDs returned to the company admin when those resources
are created:

```json
{
  "contractVersion": 1,
  "eventId": "partner-transaction-123",
  "eventType": "money_transfer",
  "occurredAt": "2026-10-13T09:00:00Z",
  "productId": "01234567-89ab-4cde-8fab-0123456789ab",
  "orgUnitId": "11234567-89ab-4cde-8fab-0123456789ab",
  "location": {
    "latitude": -1.2864,
    "longitude": 36.8172
  },
  "fields": {
    "amount": 1500
  }
}
```

### Flexible fields and meaningful analysis

- Each event uses a common envelope for fields such as event ID, event type,
  timestamp, product, and standard location. Company-specific values are
  carried as declared custom fields.
- For each custom field, the company defines a stable machine key and a
  human-readable display name and description. The display name is the identity
  shown to company users in performance views; the internal key is used by
  integrations and is not a chart label. The admin also chooses the data type
  (number, string, or boolean), unit or currency where applicable, and whether
  it is a measure, dimension, or pseudonymous identifier. Numeric measures
  need an aggregation rule and, where relevant, whether higher or lower values
  are desirable.
- The admin selects which defined fields make up business metrics, for example
  revenue less cost for profit, and gives the resulting metric its own
  human-readable name and definition, aggregation rule (sum, average, minimum,
  maximum, or count of valid events), and direction before configuring targets.
  Juu should not treat every incoming field as a standalone KPI.
- Juu presents metrics with their definitions, units, time period, product
  and geographic scope, target, and calculation status. Graph titles, axes,
  legends, filters, and data-quality messages use the admin's display names
  and units so company users see business meaning rather than internal keys.
- Validate incoming events against the company's declared contract and its
  version. Report unknown fields, missing required values, invalid types, and
  duplicate or corrected events as data-quality conditions.
- Allow the company to extend its contract over time, while making changes
  explicit and preserving the meaning of historical data. A new field or
  changed definition must not silently rewrite earlier results.
- More collected fields do not automatically produce a more complete or
  accurate analysis. Capture only values with a defined business use, and
  distinguish measured facts from derived metrics and interpretations.

### Company dashboard user selections

- Select metric, product or combined product view, date range, time grouping,
  and geography.
- Choose a supported comparison, such as actual versus target, variance, or
  percentage of target.
- Open relevant trends, map aggregates, and risk groupings, subject to their
  permissions.

Only collect a field when it is required for the company's configured
analysis. Missing or invalid inputs should be visible as data-quality issues,
not silently interpreted as zero or as successful performance.

## Company setup and integration workflow

1. The company admin first builds the organization structure and invites the
   first-level leaders. After this setup, company admins and team leaders can
   add products to the shared company catalog; each entry is attributed to the
   signed-in officer and their hierarchy scope. Admins configure metrics,
   targets, and event fields, while developers inspect the generated contract
   and integration guidance.
2. Developers integrate from the partner's web, Android, or iOS application.
   Juu should provide platform-appropriate integration libraries so app code
   can map existing values to the same versioned event contract. Partner
   end-users keep using the partner's app and do not sign in to Juu.
3. When an operation such as a money transfer succeeds, the integration sends
   the relevant event data in the background. Sender GPS can use the standard
   location field if the app obtains it with permission; Juu cannot obtain it
   automatically.
4. Financially authoritative event fields should be submitted by the partner's
   trusted backend where possible. The current integration key is a server
   secret and must not be embedded in a web bundle or Android/iOS app. Direct
   mobile/web SDK ingestion needs a separate, restricted short-lived
   credential flow before it is safe to enable.
5. The integration sends only configured fields, never sender name, phone, or
   recipient identity merely because the partner app has them. Juu validates
   and associates each event with the correct company and contract version,
   then makes authorized performance results available in the company's
   dashboard.

## Design principles

- Juu observes and analyzes business activity; the company's existing system
  remains responsible for its transactions.
- Integration is configured once, while relevant events are sent to Juu as
  they happen.
- Collect only the information needed for each company's metrics and analysis.
- Treat location as event data, not identity; avoid collecting direct personal
  identifiers for map display.
- Design the product around flexible company-defined targets and products,
  rather than NiSenti-specific assumptions.

## Backend foundation set up

The web console is published through AWS Amplify Hosting; backend resources
are provisioned directly through AWS CDK rather than Amplify's generated data
layer.

- `backend/lib/uppy-backend-stack.ts` defines a Cognito user pool, the
  `CompanyAdmin` and `UppyExecutive` groups, HTTP API, Lambda handler, and a
  DynamoDB table using on-demand billing.
- Admin routes require a Cognito token, the `CompanyAdmin` group, and a
  `custom:company_id` claim. Self-sign-up is enabled for account registration
  only; new accounts have no groups or company assignment. The app client can
  write the required email attribute but cannot write `custom:company_id` or
  assign groups. Company admins must be assigned by a trusted operator.
- Executives use a separate dashboard and protected `/v1/executive/*` API to
  create companies and invite their first admins, invite additional admins,
  and suspend/reactivate companies. Company creation, status changes, and
  invitations are recorded as audit items. Suspension blocks company-admin
  API calls and new event ingestion without deleting company data. CEO and
  additional admin invitations require an email; full name and phone number
  are optional. A provided phone number must use international format (for
  example, `+254712345678`).
- First executive setup: sign up in the Juu console and verify the email.
  In AWS Console open Cognito → User pools → `eu-north-1_0LasF9x2s` → Users,
  select the account, and add it to the `UppyExecutive` group. Then sign out
  and sign in again so the new group is present in the ID token. This manual
  step is intentionally outside the web app: users cannot grant themselves
  group membership. The trusted `provision:executive` CLI remains available
  as an operator alternative.
- Company identity is assigned through Cognito's trusted administrative user
  provisioning flow. The admin web app is not allowed to set its own
  `custom:company_id` claim; the dashboard Cognito client can read this claim
  for authorization but has no user-attribute write permissions. The company
  workspace name is loaded from the matching company profile through the
  authenticated `GET /v1/admin/company-profile` endpoint.
- `npm run provision:company-admin -- --company-name "Example Co" --admin-email
  "admin@example.com"` creates a company profile, assigns its trusted company
  claim and `CompanyAdmin` group, and asks Cognito to email the first admin.
  Set `USER_POOL_ID` and `TABLE_NAME`, and use AWS credentials authorized for
  Cognito admin-user operations and writes to the DynamoDB table (whose
  deployed CDK logical name retains the legacy `UppyData` identifier). If
  provisioning fails, the script attempts to roll back the partially created
  user and company profile.
- Admins can publish versioned event contracts, create integration keys
  (revealed only once and stored as hashes), list key metadata, and revoke keys.
- Admins can rotate integration credentials: create a replacement key, update
  the partner backend, then revoke the previous key.
- Admins can manage products, reporting locations, metric definitions, and
  targets through tenant-scoped `/v1/admin/config/{resource}` routes. Lists
  are paginated; resource IDs are generated by Juu and scoped to the
  authenticated company.
- The authenticated `GET /v1/admin/performance` report evaluates an active
  metric formula over that company's events and returns summary actuals,
  product comparisons, day/week/month buckets, reporting-location totals, and
  coarse sender-location cells. Use `metricId`, `from`, and `to` (UTC calendar
  dates); optionally provide `bucket`, `productId`, or `locationId`. Reports
  are limited to 90 calendar days, 20 DynamoDB query pages, and 5,000 scanned
  events per request. Events
  with missing or non-finite formula inputs are counted as excluded rather
  than treated as zero. GPS points are grouped into 0.05-degree cells and only
  cells with at least five matching events are returned; exact coordinates
  are never included in the report response.
- `POST /v1/admin/performance/combined` accepts a date range, operator, and
  `left`/`right` arrays of `{metricId, productId}` selections; an optional
  `orgUnitId` limits an admin report to that unit's subtree. Each side accepts
  up to 20 selections, and each group must use a consistent unit. The report
  combines values by matching reporting bucket (daily in the current view),
  then applies the selected operation between groups. The leader equivalent,
  `POST /v1/leader/performance/combined`, always derives its organization scope
  from the authenticated leader and rejects a client-supplied unit. Both
  endpoints reuse the bounded event read across all selected metrics during
  that combined request.
- The intended platform onboarding flow is for a person to sign up, then the
  trusted AWS operator to assign the first executive's Cognito group membership
  once. Juu Executives then create/review company profiles and invite the
  company's CEO by email from a separate console; their full name and
  international-format phone number are optional contact details. The CEO
  receives company administrator access associated with the company profile
  created during onboarding; the company name is not re-entered for that
  invitation. From the
  company workspace, the CEO creates organization units and invites leaders by
  entering each leader's email and selecting their unit; full name and
  international-format phone number are optional contact details. Those
  invitations inherit the company from the authenticated admin and the unit from
  the invitation request. If either contact detail is omitted, the form warns
  but still permits the invitation. Existing records without these details
  remain valid, and omitted values are not stored. Provided phone numbers are
  stored but are not SMS-verified; invitations continue to be sent by email.
  Neither role can grant itself or another user executive membership through
  the web client.
- Metric formulas are evaluated per matching event and then combined using
  the metric's selected aggregation rule. `count` counts events for which the
  formula could be evaluated; distinct-person counting is not implemented by
  this first report API.
- Metric definitions use a bounded formula tree of numeric event fields,
  constants, and arithmetic operations. In the Performance view, users can
  optionally group multiple event-derived product metrics on either side of an
  addition, subtraction, multiplication, or division. The view combines the
  groups by reporting day without saving a new metric or changing existing
  targets; addition and subtraction require matching units. Matching fixed
  targets can be selected for every group item to show the combined target
  variance; a target must match the selected product, metric, organization
  unit, and exact date range. Existing saved percentage targets remain
  available through the regular saved-target report flow. Previously saved
  calculated metrics remain readable for compatibility. Metrics and targets
  are immutable after creation; admins deactivate and replace them instead of rewriting
  definitions used to interpret historical performance.
- A metric is pinned to the event-contract version active when it is created.
  Reports do not apply its formula to events from later contract versions,
  preserving the meaning of earlier inputs.
- Fixed-value targets remain the default. Leaders can additionally set a
  percentage target: the selected product/metric's total must be at least the
  configured percentage of a second product/metric's total over the same
  dates, reporting bucket, and assigned organization subtree. Both metrics
  must have compatible units. A reference total of zero, or a period with no
  reference data, is not treated as zero-percent performance; that comparison
  is excluded and reported explicitly. A performance request can include
  `referenceMetricId` and `referenceProductId` together to return the actual
  share as a percentage.
- Targets must reference an active metric and, when scoped, an active product
  and location belonging to the same company. Event-derived targets select a
  product; legacy calculated metrics carry their component product scopes in
  the metric definition. Reporting locations can be regions or coordinate
  points, with optional parent regions.
- Partner systems submit events using the integration key. The API validates
  the event against its declared contract, checks event IDs for duplicates,
  verifies the product and optional reporting location belong to the key's
  company, and stores accepted events under that company partition.
- The initial API is an HTTP backend integration usable by partner servers.
  It is not yet a safe direct-from-browser or direct-from-mobile credential
  flow; platform SDKs and restricted short-lived client credentials remain to
  be designed.
- Executive routes require an authenticated Cognito JWT containing the
  `UppyExecutive` group. The backend enforces that group independently of the
  dashboard:
  - `GET /v1/executive/companies` (paginated directory)
  - `POST /v1/executive/companies` with `companyName` and `adminEmail`;
    `adminName` and `adminPhoneNumber` are optional
  - `POST /v1/executive/companies/{companyId}/admins` with `adminEmail`;
    `adminName` and `adminPhoneNumber` are optional
  - `PUT /v1/executive/companies/{companyId}/status` with `status` and
    required audit `reason`
  Optional contact-field support is implemented in source but not yet
  deployed; deploy the API and Cognito client updates before using the revised
  invitation forms against production.
- The CEO/company admin should build the organization and jurisdiction
  structure as the first setup step. Organization units are also the scope for
  leader reporting and unit targets. Leaders may create only immediate child
  units and invite a leader for one of those child units; the backend derives
  the company and parent from the authenticated leader assignment. These
  writes use `POST /v1/leader/org-units` and
  `POST /v1/leader/org-units/{orgUnitId}/leaders` with `leaderEmail`;
  `leaderName` and `leaderPhoneNumber` are optional. Deeper hierarchy creation
  is delegated one level at a time. The delegated leader-write routes and
  continent/country jurisdiction validation are deployed to AWS.
- The dashboard onboarding checklist puts organization structure first,
  followed by company-wide products, event definitions, and metrics. The CEO
  or company admin creates these shared definitions after at least one active
  organization unit exists. Products are created through
  `POST /v1/admin/config/products`; reads for team leaders use
  `GET /v1/leader/products`. Product creator metadata is stamped by the server
  and cannot be supplied or overridden by clients.
- Company admins create company-wide targets through
  `POST /v1/admin/config/targets`. A company target cannot specify an
  organization unit and may use only active products created by that admin.
  Eligible product IDs are returned with `GET /v1/admin/config/targets`.
- Team leaders create targets through `POST /v1/leader/targets`, using an
  active product that has an active target from their direct manager. A
  top-level leader inherits the CEO's company-wide targets; a nested leader
  inherits only targets assigned to their direct manager's unit. The server
  assigns the leader's active unit and records the authenticated officer as
  creator; a leader cannot target another unit or an undelegated product by
  sending different IDs. Leaders
  may retain the default fixed-value target or submit `targetMode: "percentage"`
  with `referenceMetricId` and `referenceProductId`; `targetValue` then means
  the minimum share percentage. Referenced products and metrics are validated
  against the company, and both metrics must use the same unit. A
  calculated primary metric already defines its component products, so its
  target does not take an additional product ID. Percentage performance can
  be viewed through the performance endpoint by supplying the same reference
  IDs alongside `metricId`, `productId` (for event-derived metrics), `from`,
  and `to`. The leader workspace can load a saved target's metric, comparison,
  threshold, and date range into the performance report. Leaders can review
  their own targets through `GET /v1/leader/targets`. Company
  admins review the company-wide target register through
  `GET /v1/admin/config/targets`.
- Standard event fields and company-defined custom fields are implemented in
  `backend/src/domain/event-contract.ts`. Custom field definitions include
  the machine key, display label, type, role, unit, and aggregation metadata;
  metric formulas and configuration validation are implemented in
  `backend/src/domain/configuration.ts`; automated tests cover contracts,
  event validation, products, locations, metrics, and targets.
- Configuration API routes protected by the company-admin JWT authorizer:
  - `GET|POST /v1/admin/config/{products|locations|metrics}`
  - `GET /v1/admin/config/targets`
  - `GET|PUT|DELETE /v1/admin/config/{products|locations|metrics|targets}/{id}`
  - `GET /v1/admin/performance`
  - `POST /v1/admin/performance/combined`
  - Product creation is blocked until at least one active organization unit
    exists; creator profile and hierarchy attribution are generated server-side.
  - `PUT` on metrics and targets returns `409`; deactivate the existing
    definition and create a new one to preserve historical meaning.
- Configuration create requests return Juu-generated UUID resource IDs.
  Metric formulae are bounded expression trees, not executable code. A
  calculated metric's `calculation` contains an operator and two operands,
  each with an active event-derived `metricId` and active `productId`.
  Targets must reference an active metric and may be scoped to an active
  product and reporting location; percentage targets also reference a second
  active metric and product. Deactivation is soft; stored events and
  configurations are retained.
- Admin configuration is managed through `GET|POST` on a resource collection
  and `GET|PUT|DELETE` on an item ID. Create a product with `{"name":
  "Money transfers"}`; use its returned ID in event payloads. A metric
  definition provides its own display name and unit and refers to numeric
  fields declared by the active event contract. For example, profit can be
  defined as a `subtract` expression with `revenue` and `cost` field operands.
  A target refers to a metric ID and can be scoped by product, location,
  reporting period, start/end dates, and target value.
- An initial React company console is under `frontend/`. It uses Cognito sign-in
  and the authenticated company-admin APIs to configure products, locations,
  event contracts, metrics, targets, organization units, and server
  integration keys. Team leaders also have an authenticated flow to add
  products to the shared company catalog, with product creator/unit metadata
  derived by the backend. It includes event and calculated-metric performance
  reporting and same-period percentage-of-reference reporting. Full target
  attainment and geographic target comparisons remain future work. The developer
  guide shows the current event-ingestion flow.
- To run the console locally, copy `frontend/.env.example` to
  `frontend/.env.local`, fill in the `ApiUrl`, `UserPoolId`, and
  `UserPoolClientId` stack outputs as the corresponding `VITE_` settings. The
  development server proxies API requests through its own origin to avoid
  browser CORS restrictions; this proxy is development-only. The deployed
  stack values have been configured in the local ignored `frontend/.env.local`;
  run `npm run dev:web` to open the console. Run `npm run build` to type-check
  the backend and production-build the console.
- The HTTP API allows browser requests from `http://localhost:5173` and
  `http://127.0.0.1:4173` by default. When hosting the console elsewhere,
  synthesize/deploy with
  `-c webOrigin=https://your-console-domain` so the API CORS policy permits
  that exact origin. The production console is hosted at
  `https://main.d7df7s7wzn6vn.amplifyapp.com/` by the Amplify app in
  `eu-north-1` (AWS app name `Uppy`; product display name `Juu`); its API CORS
  origin is configured in the deployed stack.
  Amplify Hosting uses a manually uploaded static build (no Git repository or
  automatic branch build is connected).
- Infrastructure and handler code are under `backend/`; run `npm install`,
  `npm test`, `npm run build`, and `npm run synth` to install, test, type-check,
  and synthesize the stack. For a new account/region, deployment requires
  `npx cdk bootstrap aws://ACCOUNT_ID/REGION` once, followed by
  `npx cdk deploy UppyBackendStack`; synthesis alone does not deploy resources.
- The table uses pay-per-request capacity and AWS-managed encryption. Data
  retention, backups, and a production recovery policy still need to be
  designed before production use.

## Usage-based company billing

Company charges are usage-based in KES, with no free allowance or setup fee.
Juu meters each newly accepted, unique partner event and each successful
company or leader performance presentation read (including combined reports).
Rejected events, duplicate event IDs, failed reports, and company setup or
configuration operations are not customer-billable. Map-boundary rendering
currently uses no paid map API or tile service.

Platform executives configure separate ingestion and presentation rates per
1,000 billable calls in the executive dashboard. The initial rates take effect
immediately; later changes are scheduled for the next calendar month. Rates
are captured with each company's monthly usage so later changes do not alter
closed-month calculations. Until rates are configured and billing is explicitly
enabled with a Pesapal secret, partner event ingestion and performance
presentation endpoints return an explicit unavailable response rather than
silently providing unmetered usage.

Company admins can view current-month usage and estimated charges in Billing
and download a PDF invoice after a billing month closes. The company workspace
account area also shows the count and total of outstanding invoices and links
directly to Billing. Invoice generation is based on the recorded monthly usage
and rate snapshot. Hosted Pesapal checkout
offers the payment methods enabled on Juu's merchant account (including card
and mobile-money methods); payment completion is confirmed server-to-server,
not trusted from the browser redirect. Billable ingestion and presentation
calls are paused when an invoice remains unpaid seven days after issue; setup,
configuration, billing, and payment routes remain available. Billing periods
follow the `Africa/Nairobi` calendar month.

The executive dashboard includes a paginated outstanding-invoice overview
across companies alongside the platform rate controls. Juu platform executives
can also record an invoice as paid when the company pays by an offline or
otherwise manually reconciled method. The executive must
select the payment method; a transaction or receipt reference may be recorded.
The action stores the executive identity, timestamp, and invoice details in
the company audit history and is available without Pesapal credentials. An
invoice with a pending Pesapal checkout cannot be manually settled until that
checkout is resolved, to reduce the risk of recording a second payment.

Pesapal is sandbox-only by default, and billable usage is disabled by default
even if a secret ARN is supplied. First deploy without enabling billing and
use the stack's API URL output to register a GET IPN with Pesapal pointing to
`<API_URL>/v1/billing/pesapal/ipn`. Then create an AWS Secrets Manager secret
containing `consumerKey`, `consumerSecret`, and the returned `notificationId`.
After verifying the sandbox account, IPN, and checkout configuration, explicitly
enable billing by deploying with the complete secret ARN:

```text
npx cdk deploy UppyBackendStack -c webOrigin=https://your-console-domain -c pesapalSecretArn=arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME -c pesapalEnvironment=sandbox -c billingEnabled=true
```

`billingEnabled` defaults to `false`; billable ingestion and presentations
remain paused until both positive KES rates and billing activation are
configured. Existing invoices remain accessible and payable while new usage
is paused. Only use `-c pesapalEnvironment=live` and enable live billing after
the live merchant account, credentials, IPN, customer rates, and checkout flow
have been verified. Do not put Pesapal credentials in source control or CDK
context values.

## Current AWS deployment

On 2026-10-13, the CDK toolkit was bootstrapped and `UppyBackendStack` deployed
to `eu-north-1` using the locally configured `NiSenti` AWS profile. CloudFormation
reports `CREATE_COMPLETE`, and `GET /v1/health` returned `{"status":"ok"}`.
The deployed API URL is
`https://cdp3qcgyx9.execute-api.eu-north-1.amazonaws.com`. The executive
dashboard, protected executive APIs, and `UppyExecutive` Cognito group were
subsequently deployed to the same stack; CloudFormation reports
`UPDATE_COMPLETE`. On 2026-10-13, the hierarchy release added the `CompanyLeader`
Cognito group and leader reporting APIs to that stack; the CDK diff contained
only additions and a Lambda code update, with no resource replacements.
CloudFormation reports `UPDATE_COMPLETE`; `GET /v1/health` returns
`{"status":"ok"}`, and unauthenticated requests to the leader APIs are rejected.
The 2026-10-13 jurisdiction update deployed the delegated direct-child leader
routes and validation for optional continent-, country-, and administrative-
level jurisdictions. The live Amplify origin remains in API CORS configuration.

An executive account and the first company admin have been provisioned for
NiSenti, and the company workspace is active. The hierarchy release was
published to Amplify's `main` branch (deployment job 9 succeeded) at
`https://main.d7df7s7wzn6vn.amplifyapp.com/`; the company organization screen
and its bundled Kenya boundary data load successfully. On 2026-10-14, the
backend was updated with product-specific calculated metrics and percentage
performance comparisons, preserving the production CORS origin. The frontend
was published to Amplify `main` in deployment job 14; its JS and CSS assets
were verified to return HTTP 200, and the CEO Metrics screen was opened
successfully. The frontend archive must use POSIX paths so Amplify serves
bundled assets correctly. The 2026-10-14 target cascade release enabled
company admins to set company-wide targets for products they created and
restricted each team leader to products with active targets from their direct
manager. Amplify deployment job 18 published the CEO and leader target
interfaces. API Gateway was also updated with the protected `GET` and `POST`
`/v1/leader/targets` routes and the protected `GET /v1/leader/products` route.
The latter route was missing initially, causing the leader product request to
fail and appear as a browser CORS error; after adding the route, unauthenticated
requests return `401` with the configured production origin. The backend stack
reports `UPDATE_COMPLETE`, and `BILLING_ENABLED` remains `false`. New users can
sign up, but a trusted operator must assign their Cognito group before they
receive administrative access. AWS resources are active; DynamoDB uses
on-demand billing, and API Gateway, Lambda execution, Cognito, Amplify Hosting,
and CloudWatch logging may incur usage-based charges.
On 2026-10-14, Amplify deployment job 20 published the synchronized geographic
boundary picker: map selection updates the selected jurisdiction, search field,
map highlight, and confirmation action. The production page and its JS/CSS
assets returned HTTP 200 after deployment.
Amplify job 21 published the selectable company/leader reporting tree, including
selected-unit details. The leader organization API now returns leader contact
details within the assigned unit's active subtree. The backend stack reports
`UPDATE_COMPLETE`; API health returns `ok`, unauthenticated leader-unit
requests return `401` with the configured production CORS origin, and the
production page plus JS/CSS assets return HTTP 200.

## Next backend and product steps

1. Complete the company Performance view with actual-versus-target reporting,
   comparisons, and geographic summaries.
2. Add effective-dated hierarchy and leader assignments so historical reports
   retain the organization that applied when an event occurred.
3. Implement custom territory polygons and coordinate-based attribution only
   after defining boundary licensing, overlap resolution, and ambiguous-match
   handling.
4. Add other administrative boundary datasets only after reviewing their
   coverage, licensing, and suitability.
5. Add distinct-sender counting only when explicitly configured and backed by
   partner-provided pseudonymous identifiers or partner-aggregated counts.
6. Add cluster analysis when there is enough comparable data; explain its
   basis and avoid implying that correlations establish causes.
7. Connect the Amplify app to a Git repository for automatic frontend
   deployments, if desired; the current production site uses manual static
   artifact uploads.
8. Design platform SDKs for web, Android, and iOS. Keep financial event
   submission server-authoritative; only allow direct client submission after
   a scoped, short-lived credential design is implemented.
9. Add data-retention controls, operational monitoring, recovery settings, and
   AWS budgets; validate access isolation and results before production use.

## Project status

The currently deployed stack contains the backend infrastructure, event
ingestion, company-admin configuration APIs, bounded performance calculation
API, and executive and company-leader Cognito groups in `eu-north-1`. Protected
company-management APIs include nested organization units, leader invitations,
unit-scoped targets, and subtree-limited leader reports. The Juu company
console, including the organization and jurisdiction workflow, is published
through Amplify Hosting at `https://main.d7df7s7wzn6vn.amplifyapp.com/`.
The deployed backend supports optional continent, country, and administrative
jurisdictions and delegated direct-child unit creation/leader invitations.
It also retains backend compatibility for previously saved calculated metrics
and supports same-period percentage-of-reference reports/targets. The published
workspaces provide an optional, report-time combined product analysis in
addition to the existing single-metric and saved-target reports.
Public account registration is enabled for unassigned accounts; it grants no
workspace access until a trusted operator assigns a Cognito group. NiSenti has
not yet created organization units or leader assignments, and no partner
events have been ingested. Full performance visualizations and target
comparisons, historical assignments, custom territories and automatic
geographic attribution, distinct-sender analysis, cluster analysis, platform
SDKs, and production retention/recovery controls remain to be built.
