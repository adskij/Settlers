// Azure App Service (Linux, Containers) for the Settlers app.
// Deploys a single Web App for Containers that pulls the image from GHCR,
// with WebSockets enabled and persistent storage for the SQLite database.

@description('Globally-unique Web App name (becomes <name>.azurewebsites.net).')
param appName string

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Full container image reference, e.g. ghcr.io/owner/settlers:<sha>.')
param containerImage string

@secure()
@description('JWT signing secret used by the app to sign sessions.')
param jwtSecret string

@description('App Service plan SKU. B1 is the cheapest tier that supports Always On.')
param sku string = 'B1'

@description('Optional GHCR username for pulling a PRIVATE image. Leave empty for a public image.')
param registryUsername string = ''

@secure()
@description('Optional GHCR token/PAT (read:packages) for a PRIVATE image. Leave empty for a public image.')
param registryPassword string = ''

var planName = '${appName}-plan'
var registryUrl = 'https://ghcr.io'

// Base app settings. The container listens on 4000; App Service routes to it
// via WEBSITES_PORT. /home is persistent storage, so SQLite survives restarts
// and redeploys (keep this app at a SINGLE instance — SQLite is not multi-writer).
var baseAppSettings = [
  {
    name: 'WEBSITES_PORT'
    value: '4000'
  }
  {
    name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE'
    value: 'true'
  }
  {
    name: 'DATABASE_PATH'
    value: '/home/data/settlers.db'
  }
  {
    name: 'JWT_SECRET'
    value: jwtSecret
  }
  {
    name: 'NODE_ENV'
    value: 'production'
  }
]

// Only attach registry credentials when a username is supplied (private image).
var registrySettings = empty(registryUsername) ? [] : [
  {
    name: 'DOCKER_REGISTRY_SERVER_URL'
    value: registryUrl
  }
  {
    name: 'DOCKER_REGISTRY_SERVER_USERNAME'
    value: registryUsername
  }
  {
    name: 'DOCKER_REGISTRY_SERVER_PASSWORD'
    value: registryPassword
  }
]

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: sku
  }
  properties: {
    reserved: true // required for Linux plans
  }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux,container'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${containerImage}'
      alwaysOn: true
      webSocketsEnabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      healthCheckPath: '/health'
      appSettings: concat(baseAppSettings, registrySettings)
    }
  }
}

output url string = 'https://${app.properties.defaultHostName}'
output defaultHostName string = app.properties.defaultHostName
