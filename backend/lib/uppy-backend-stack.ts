import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'

export class UppyBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)
    const webOrigin = this.node.tryGetContext('webOrigin') ?? 'http://localhost:5173'
    const pesapalEnvironment = this.node.tryGetContext('pesapalEnvironment') ?? 'sandbox'
    const pesapalSecretArn = this.node.tryGetContext('pesapalSecretArn')
    const billingEnabledContext = this.node.tryGetContext('billingEnabled') ?? 'false'
    if (billingEnabledContext !== 'true' && billingEnabledContext !== 'false') {
      throw new Error('billingEnabled must be true or false')
    }
    const billingEnabled = billingEnabledContext === 'true'
    if (pesapalEnvironment !== 'sandbox' && pesapalEnvironment !== 'live') {
      throw new Error('pesapalEnvironment must be sandbox or live')
    }
    if (pesapalSecretArn !== undefined && typeof pesapalSecretArn !== 'string') {
      throw new Error('pesapalSecretArn must be a complete Secrets Manager ARN')
    }
    if (billingEnabled && !pesapalSecretArn) {
      throw new Error('pesapalSecretArn is required when billingEnabled is true')
    }
    const pesapalBaseUrl = pesapalEnvironment === 'live'
      ? 'https://pay.pesapal.com/v3'
      : 'https://cybqa.pesapal.com/pesapalv3'

    const userPool = new cognito.UserPool(this, 'CompanyUsers', {
      userPoolName: 'uppy-company-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      customAttributes: {
        company_id: new cognito.StringAttribute({ mutable: true }),
      },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const userPoolClient = userPool.addClient('CompanyDashboardClient', {
      userPoolClientName: 'uppy-company-dashboard',
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, fullname: true, phoneNumber: true })
        .withCustomAttributes('company_id'),
      writeAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true }),
    })

    new cognito.CfnUserPoolGroup(this, 'CompanyAdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'CompanyAdmin',
      description: 'Company administrators who can configure Uppy integrations',
    })

    new cognito.CfnUserPoolGroup(this, 'CompanyLeaderGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'CompanyLeader',
      description: 'Company team leaders with access only to their assigned unit and descendants',
    })

    new cognito.CfnUserPoolGroup(this, 'UppyExecutiveGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'UppyExecutive',
      description: 'Uppy platform executives who manage company onboarding and status',
    })

    const table = new dynamodb.Table(this, 'UppyData', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const apiHandler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        USER_POOL_ID: userPool.userPoolId,
        PESAPAL_SECRET_ARN: pesapalSecretArn ?? '',
        PESAPAL_BASE_URL: pesapalBaseUrl,
        PESAPAL_CALLBACK_URL: `${webOrigin.replace(/\/+$/, '')}/?billing=return`,
        BILLING_ENABLED: billingEnabled ? 'true' : 'false',
      },
      bundling: {
        target: 'node22',
        minify: true,
        sourceMap: true,
      },
    })
    table.grantReadWriteData(apiHandler)
    if (pesapalSecretArn) {
      secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'PesapalCredentials',
        pesapalSecretArn,
      ).grantRead(apiHandler)
    }
    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
      ],
      resources: [userPool.userPoolArn],
    }))

    const httpApi = new apigwv2.CfnApi(this, 'UppyHttpApi', {
      name: 'uppy-api',
      protocolType: 'HTTP',
      corsConfiguration: {
        allowOrigins: [
          webOrigin,
          'http://127.0.0.1:4173',
        ],
        allowHeaders: ['authorization', 'content-type', 'x-uppy-api-key'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        exposeHeaders: ['x-amzn-requestid', 'x-amz-apigw-id'],
        maxAge: 86400,
      },
    })
    const integration = new apigwv2.CfnIntegration(this, 'ApiHandlerIntegration', {
      apiId: httpApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: apiHandler.functionArn,
      integrationMethod: 'POST',
      payloadFormatVersion: '2.0',
    })
    apiHandler.addPermission('HttpApiInvokePermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: this.formatArn({
        service: 'execute-api',
        resource: httpApi.ref,
        resourceName: '*/*',
      }),
    })

    const jwtAuthorizer = new apigwv2.CfnAuthorizer(this, 'CompanyUserAuthorizer', {
      apiId: httpApi.ref,
      authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      name: 'company-user-authorizer',
      jwtConfiguration: {
        audience: [userPoolClient.userPoolClientId],
        issuer: `https://cognito-idp.${this.region}.${this.urlSuffix}/${userPool.userPoolId}`,
      },
    })

    const routes: Array<{ key: string; admin?: boolean }> = [
      { key: 'GET /v1/health' },
      { key: 'POST /v1/events' },
      { key: 'GET /v1/admin/event-contract', admin: true },
      { key: 'PUT /v1/admin/event-contract', admin: true },
      { key: 'GET /v1/admin/performance', admin: true },
      { key: 'GET /v1/admin/integration-keys', admin: true },
      { key: 'POST /v1/admin/integration-keys', admin: true },
      { key: 'DELETE /v1/admin/integration-keys/{integrationId}', admin: true },
      { key: 'GET /v1/admin/config/{resource}', admin: true },
      { key: 'POST /v1/admin/config/{resource}', admin: true },
      { key: 'GET /v1/admin/config/{resource}/{id}', admin: true },
      { key: 'PUT /v1/admin/config/{resource}/{id}', admin: true },
      { key: 'DELETE /v1/admin/config/{resource}/{id}', admin: true },
      { key: 'GET /v1/executive/companies', admin: true },
      { key: 'POST /v1/executive/companies', admin: true },
      { key: 'PUT /v1/executive/companies/{companyId}/status', admin: true },
      { key: 'POST /v1/executive/companies/{companyId}/admins', admin: true },
      { key: 'GET /v1/admin/company-profile', admin: true },
      { key: 'POST /v1/admin/org-units/{orgUnitId}/leaders', admin: true },
      { key: 'GET /v1/leader/performance', admin: true },
      { key: 'GET /v1/leader/org-units', admin: true },
      { key: 'GET /v1/leader/metrics', admin: true },
      { key: 'POST /v1/leader/org-units', admin: true },
      { key: 'POST /v1/leader/org-units/{orgUnitId}/leaders', admin: true },
      { key: 'POST /v1/admin/performance/combined', admin: true },
      { key: 'POST /v1/leader/performance/combined', admin: true },
      { key: 'GET /v1/executive/billing-rates', admin: true },
      { key: 'PUT /v1/executive/billing-rates', admin: true },
      { key: 'GET /v1/executive/companies/{companyId}/billing', admin: true },
      { key: 'POST /v1/executive/companies/{companyId}/billing/invoices/{month}/mark-paid', admin: true },
      { key: 'GET /v1/admin/billing', admin: true },
      { key: 'GET /v1/admin/billing/invoices/{month}/pdf', admin: true },
      { key: 'POST /v1/admin/billing/invoices/{month}/checkout', admin: true },
      { key: 'GET /v1/admin/billing/invoices/{month}/payment-status', admin: true },
      { key: 'GET /v1/billing/pesapal/ipn' },
      { key: 'GET /v1/executive/billing', admin: true },
      { key: 'GET /v1/leader/targets', admin: true },
      { key: 'POST /v1/leader/targets', admin: true },
      { key: 'GET /v1/leader/products', admin: true },
    ]

    routes.forEach((route, index) => {
      new apigwv2.CfnRoute(this, `Route${index + 1}`, {
        apiId: httpApi.ref,
        routeKey: route.key,
        target: `integrations/${integration.ref}`,
        authorizationType: route.admin ? 'JWT' : 'NONE',
        authorizerId: route.admin ? jwtAuthorizer.ref : undefined,
      })
    })

    new apigwv2.CfnStage(this, 'DefaultStage', {
      apiId: httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
    })

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${httpApi.ref}.execute-api.${this.region}.${this.urlSuffix}`,
    })
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId })
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    })
    new cdk.CfnOutput(this, 'DynamoDbTableName', { value: table.tableName })
  }
}
