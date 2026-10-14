import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'

const userPoolId = process.env.USER_POOL_ID
if (!userPoolId) throw new Error('USER_POOL_ID environment variable is required')

const cognito = new CognitoIdentityProviderClient({})

async function provisionExecutive(): Promise<void> {
  const email = readEmail(process.argv.slice(2)).toLowerCase()
  let userCreated = false
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [{ Name: 'email', Value: email }],
    }))
    userCreated = true
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: email,
      GroupName: 'UppyExecutive',
    }))
  } catch (error) {
    if (userCreated) {
      try {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Executive provisioning failed and Cognito rollback was incomplete',
        )
      }
    }
    throw error
  }

  process.stdout.write(`${JSON.stringify({
    executiveEmail: email,
    status: 'Uppy Executive invited by email',
  }, null, 2)}\n`)
}

function readEmail(arguments_: string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== '--email') {
    throw new Error('Use --email "<executive-email>"')
  }
  const email = arguments_[1].trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('--email must be a valid email address')
  }
  return email
}

void provisionExecutive().catch((error: unknown) => {
  process.stderr.write(`Uppy Executive provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
