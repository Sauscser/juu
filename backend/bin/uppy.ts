import * as cdk from 'aws-cdk-lib'
import { UppyBackendStack } from '../lib/uppy-backend-stack'

const app = new cdk.App()

new UppyBackendStack(app, 'UppyBackendStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
