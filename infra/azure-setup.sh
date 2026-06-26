#!/usr/bin/env bash
#
# One-time setup for GitHub -> Azure continuous deployment.
# Run this LOCALLY on a machine where you are logged in to Azure (`az login`).
# It is the only step that needs your Azure credentials; afterwards every push
# to `main` deploys automatically from GitHub Actions.
#
# What it does:
#   1. Creates a resource group.
#   2. Creates an Entra ID app + service principal for GitHub OIDC (no secrets).
#   3. Grants it Contributor on the resource group.
#   4. Adds a federated credential bound to this repo's `production` environment.
#   5. Prints (or sets, with --gh) the GitHub secrets/variables the workflow needs.
#
# Usage:
#   az login
#   az account set --subscription "<your-subscription-id-or-name>"
#   ./infra/azure-setup.sh            # prints the values to add to GitHub
#   ./infra/azure-setup.sh --gh       # also sets them via the `gh` CLI
#
set -euo pipefail

# ---- Config (override via environment variables) ----------------------------
GITHUB_REPO="${GITHUB_REPO:-adskij/Settlers}"   # owner/repo
RESOURCE_GROUP="${RESOURCE_GROUP:-settlers-rg}"
LOCATION="${LOCATION:-eastus}"
# Web App name must be globally unique -> default appends a random suffix.
WEBAPP_NAME="${WEBAPP_NAME:-settlers-app-$RANDOM}"
APP_REG_NAME="${APP_REG_NAME:-settlers-github-oidc}"
GH_ENVIRONMENT="${GH_ENVIRONMENT:-production}"   # must match `environment:` in deploy.yml
# -----------------------------------------------------------------------------

USE_GH=false
[[ "${1:-}" == "--gh" ]] && USE_GH=true

echo "==> Using subscription:"
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
az account show --query '{name:name, id:id}' -o yaml

echo "==> Creating resource group '$RESOURCE_GROUP' in '$LOCATION'..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none

echo "==> Ensuring Entra ID app registration '$APP_REG_NAME'..."
APP_ID="$(az ad app list --display-name "$APP_REG_NAME" --query '[0].appId' -o tsv)"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$(az ad app create --display-name "$APP_REG_NAME" --query appId -o tsv)"
  echo "    created app $APP_ID"
else
  echo "    reusing existing app $APP_ID"
fi

# Service principal for the app (idempotent).
if ! az ad sp show --id "$APP_ID" >/dev/null 2>&1; then
  az ad sp create --id "$APP_ID" -o none
  echo "    created service principal"
fi
SP_OBJECT_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"

echo "==> Granting Contributor on the resource group..."
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP" \
  -o none 2>/dev/null || echo "    (role assignment already exists)"

echo "==> Adding federated credential for repo '$GITHUB_REPO' env '$GH_ENVIRONMENT'..."
SUBJECT="repo:${GITHUB_REPO}:environment:${GH_ENVIRONMENT}"
CRED_NAME="github-${GH_ENVIRONMENT}"
if ! az ad app federated-credential list --id "$APP_ID" --query "[?subject=='$SUBJECT']" -o tsv | grep -q .; then
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"$CRED_NAME\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$SUBJECT\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" -o none
  echo "    created federated credential ($SUBJECT)"
else
  echo "    federated credential already exists"
fi

echo ""
echo "============================================================"
echo " GitHub configuration for $GITHUB_REPO"
echo "============================================================"
echo " Secrets:"
echo "   AZURE_CLIENT_ID        = $APP_ID"
echo "   AZURE_TENANT_ID        = $TENANT_ID"
echo "   AZURE_SUBSCRIPTION_ID  = $SUBSCRIPTION_ID"
echo "   JWT_SECRET             = <generate one, e.g. $(openssl rand -hex 32 2>/dev/null || echo 'openssl rand -hex 32')>"
echo " Variables:"
echo "   AZURE_RESOURCE_GROUP   = $RESOURCE_GROUP"
echo "   AZURE_WEBAPP_NAME      = $WEBAPP_NAME"
echo "   AZURE_LOCATION         = $LOCATION"
echo "============================================================"

if $USE_GH; then
  if ! command -v gh >/dev/null; then
    echo "!! 'gh' CLI not found; set the values above manually." >&2
    exit 1
  fi
  echo "==> Setting GitHub secrets/variables via gh..."
  JWT_VALUE="$(openssl rand -hex 32)"
  gh secret set AZURE_CLIENT_ID       --repo "$GITHUB_REPO" --body "$APP_ID"
  gh secret set AZURE_TENANT_ID       --repo "$GITHUB_REPO" --body "$TENANT_ID"
  gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$SUBSCRIPTION_ID"
  gh secret set JWT_SECRET            --repo "$GITHUB_REPO" --body "$JWT_VALUE"
  gh variable set AZURE_RESOURCE_GROUP --repo "$GITHUB_REPO" --body "$RESOURCE_GROUP"
  gh variable set AZURE_WEBAPP_NAME    --repo "$GITHUB_REPO" --body "$WEBAPP_NAME"
  gh variable set AZURE_LOCATION       --repo "$GITHUB_REPO" --body "$LOCATION"
  echo "    done. JWT_SECRET was generated and stored."
fi

echo ""
echo "Next: push to 'main' (or run the 'Deploy to Azure' workflow manually)."
echo "After the first deploy, make the GHCR package public so App Service can pull it:"
echo "  GitHub -> your profile -> Packages -> settlers -> Package settings -> Change visibility -> Public"
echo "(Or keep it private and re-run the Bicep with registryUsername/registryPassword.)"
