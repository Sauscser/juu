import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Amplify } from 'aws-amplify'
import { fetchAuthSession } from 'aws-amplify/auth'
import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import './styles.css'
import { AdminApp } from './AdminApp'
import { ExecutiveApp } from './ExecutiveApp'
import { LeaderApp } from './LeaderApp'
import { BrandMark } from './BrandMark'

const config = {
  apiUrl: import.meta.env.DEV
    ? import.meta.env.VITE_UPPY_API_URL ? '/api' : undefined
    : import.meta.env.VITE_UPPY_API_URL?.replace(/\/+$/, ''),
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
}

function ConfigurationRequired() {
  return (
    <main className="config-error">
      <BrandMark />
      <p className="eyebrow">Workspace setup</p>
      <h1>Connect this workspace to Juu</h1>
      <p>
        Copy <code>frontend/.env.example</code> to <code>frontend/.env.local</code> and
        enter the API URL, Cognito user-pool ID, and app-client ID from your deployed
        stack outputs. Restart the web development server when done.
      </p>
    </main>
  )
}

function AuthenticatedWorkspace({
  email,
  apiUrl,
  onSignOut,
}: {
  email: string
  apiUrl: string
  onSignOut: () => void | Promise<void>
}) {
  const [role, setRole] = useState<'loading' | 'executive' | 'company-admin' | 'company-leader' | 'unauthorized' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void fetchAuthSession().then((session) => {
      const claim = session.tokens?.idToken?.payload['cognito:groups']
      const groups = Array.isArray(claim)
        ? claim
        : typeof claim === 'string'
          ? claim.replace(/^\[|\]$/g, '').split(',').map((group) => group.trim().replace(/^"|"$/g, ''))
          : []
      if (!active) return
      if (groups.includes('UppyExecutive')) setRole('executive')
      else if (groups.includes('CompanyAdmin')) setRole('company-admin')
      else if (groups.includes('CompanyLeader')) setRole('company-leader')
      else setRole('unauthorized')
    }).catch((cause: unknown) => {
      if (!active) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setRole('error')
    })
    return () => { active = false }
  }, [])

  if (role === 'loading') return <main className="config-error"><p>Checking your Juu access…</p></main>
  if (role === 'executive') {
    return <ExecutiveApp apiUrl={apiUrl} email={email} onSignOut={onSignOut} />
  }
  if (role === 'company-admin') {
    return <AdminApp apiUrl={apiUrl} email={email} onSignOut={onSignOut} />
  }
  if (role === 'company-leader') {
    return <LeaderApp apiUrl={apiUrl} email={email} onSignOut={onSignOut} />
  }
  if (role === 'unauthorized') {
    return (
      <main className="config-error">
        <h1>You do not have administrative access yet.</h1>
      </main>
    )
  }
  return (
    <main className="config-error" role="alert">
      <BrandMark />
      <p className="eyebrow">Workspace access</p>
      <h1>Unable to check your access</h1>
      <p>{error}</p>
      <button className="secondary-button" onClick={() => { void onSignOut() }}>Sign out</button>
    </main>
  )
}

if (!config.apiUrl || !config.userPoolId || !config.userPoolClientId) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><ConfigurationRequired /></React.StrictMode>,
  )
} else {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  })

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Authenticator>
        {({ signOut, user }) => (
          <AuthenticatedWorkspace
            apiUrl={config.apiUrl}
            email={user?.signInDetails?.loginId ?? user?.username ?? 'Company admin'}
            onSignOut={async () => { await signOut?.() }}
          />
        )}
      </Authenticator>
    </React.StrictMode>,
  )
}
