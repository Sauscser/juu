import { randomUUID } from 'node:crypto'
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'

const userPoolId = process.env.USER_POOL_ID
const tableName = process.env.TABLE_NAME

if (!userPoolId) throw new Error('USER_POOL_ID environment variable is required')
if (!tableName) throw new Error('TABLE_NAME environment variable is required')

const cognito = new CognitoIdentityProviderClient({})
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

async function provisionCompanyAdmin(): Promise<void> {
  const args = readArguments(process.argv.slice(2))
  const companyId = randomUUID()
  const username = args.adminEmail.toLowerCase()
  const now = new Date().toISOString()
  let companyCreated = false
  let userCreated = false

  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `COMPANY#${companyId}`,
              sk: 'PROFILE',
              kind: 'COMPANY_PROFILE',
              companyId,
              name: args.companyName,
              status: 'active',
              revision: 1,
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: 'COMPANY_DIRECTORY',
              sk: `COMPANY#${companyId}`,
              kind: 'COMPANY_DIRECTORY_ITEM',
              companyId,
              name: args.companyName,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }))
    companyCreated = true

    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'custom:company_id', Value: companyId },
      ],
    }))
    userCreated = true

    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: username,
      GroupName: 'CompanyAdmin',
    }))
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (userCreated) {
      try {
        await cognito.send(new AdminDeleteUserCommand({
          UserPoolId: userPoolId,
          Username: username,
        }))
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (companyCreated) {
      try {
        await database.send(new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: tableName, Key: { pk: `COMPANY#${companyId}`, sk: 'PROFILE' } } },
            { Delete: { TableName: tableName, Key: { pk: 'COMPANY_DIRECTORY', sk: `COMPANY#${companyId}` } } },
          ],
        }))
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Company admin provisioning failed and rollback was incomplete',
      )
    }
    throw error
  }

  process.stdout.write(`${JSON.stringify({
    companyId,
    companyName: args.companyName,
    adminEmail: username,
    status: 'Company admin invited by email',
  }, null, 2)}\n`)
}

function readArguments(arguments_: string[]): { companyName: string; adminEmail: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (!flag || !flag.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Use --company-name "<name>" --admin-email "<email>"')
    }
    values.set(flag, value)
  }

  const companyName = values.get('--company-name')?.trim()
  const adminEmail = values.get('--admin-email')?.trim()
  if (!companyName || companyName.length > 128) {
    throw new Error('--company-name must contain 1 to 128 characters')
  }
  if (!adminEmail || adminEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    throw new Error('--admin-email must be a valid email address')
  }
  for (const flag of values.keys()) {
    if (flag !== '--company-name' && flag !== '--admin-email') {
      throw new Error(`Unsupported argument: ${flag}`)
    }
  }
  return { companyName, adminEmail }
}

void provisionCompanyAdmin().catch((error: unknown) => {
  process.stderr.write(`Company admin provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
