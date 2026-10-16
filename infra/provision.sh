#!/usr/bin/env bash
# One-time Azure setup for visionboard.tylergreer.io. Safe to re-run; each step is create-or-update.
# Day-to-day deploys happen in GitHub Actions (.github/workflows/deploy.yml), not here.
set -euo pipefail

SUB=TylerGreerSubscription
RG=tg-visionboard
LOC=eastus
STORAGE=tgvisionboard
LOGS=tg-visionboard-logs
ENV=tg-visionboard-env
APP=visionboard
IMAGE=ghcr.io/tgreer812/visionboard:latest
DNS_RG=tylergreer-rg
ZONE=tylergreer.io
SUBDOMAIN=visionboard
HOST="$SUBDOMAIN.$ZONE"
REPO=tgreer812/visionboard

az account set --subscription "$SUB"
az extension add -n containerapp --upgrade -y -o none

# --- resource group, storage, logs -------------------------------------------------------
az group create -n "$RG" -l "$LOC" --tags app=visionboard -o none
az storage account create -n "$STORAGE" -g "$RG" -l "$LOC" --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false --tags app=visionboard -o none
CONN=$(az storage account show-connection-string -n "$STORAGE" -g "$RG" -o tsv)
for c in rooms media; do az storage container create -n "$c" --connection-string "$CONN" -o none; done
# Hourly room backups are kept for 30 days.
az storage account management-policy create --account-name "$STORAGE" -g "$RG" --policy '{
  "rules":[{"enabled":true,"name":"expire-room-backups","type":"Lifecycle","definition":{
    "actions":{"baseBlob":{"delete":{"daysAfterModificationGreaterThan":30}}},
    "filters":{"blobTypes":["blockBlob"],"prefixMatch":["rooms/backups/"]}}}]}' -o none
# 30-day retention and a 100 MB/day ingestion cap keep logs inside the free allowance.
az monitor log-analytics workspace create -g "$RG" -n "$LOGS" -l "$LOC" --retention-time 30 --quota 0.1 -o none
WS_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LOGS" --query customerId -o tsv)
WS_KEY=$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LOGS" --query primarySharedKey -o tsv)

# --- container app (exactly one always-on replica: rooms live in its memory) --------------
az containerapp env create -n "$ENV" -g "$RG" -l "$LOC" --logs-workspace-id "$WS_ID" --logs-workspace-key "$WS_KEY" -o none
if ! az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  az containerapp create -n "$APP" -g "$RG" --environment "$ENV" --image "$IMAGE" \
    --ingress external --target-port 8080 --transport auto \
    --cpu 0.25 --memory 0.5Gi --min-replicas 1 --max-replicas 1 \
    --secrets "storage-conn=$CONN" --env-vars "AZURE_STORAGE_CONNECTION_STRING=secretref:storage-conn" \
    --tags app=visionboard -o none
else
  az containerapp secret set -n "$APP" -g "$RG" --secrets "storage-conn=$CONN" -o none
fi
FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
VERIFY=$(az containerapp show -n "$APP" -g "$RG" --query properties.customDomainVerificationId -o tsv)

# --- DNS + managed certificate ------------------------------------------------------------
az network dns record-set cname set-record -g "$DNS_RG" -z "$ZONE" -n "$SUBDOMAIN" -c "$FQDN" --ttl 3600 -o none
az network dns record-set txt create -g "$DNS_RG" -z "$ZONE" -n "asuid.$SUBDOMAIN" --ttl 3600 -o none 2>/dev/null || true
az network dns record-set txt add-record -g "$DNS_RG" -z "$ZONE" -n "asuid.$SUBDOMAIN" -v "$VERIFY" -o none 2>/dev/null || true
az containerapp hostname add -n "$APP" -g "$RG" --hostname "$HOST" -o none 2>/dev/null || true
az containerapp hostname bind -n "$APP" -g "$RG" --hostname "$HOST" --environment "$ENV" --validation-method CNAME -o none

# --- GitHub Actions deploy identity (OIDC, no stored secrets) ------------------------------
APP_ID=$(az ad app list --display-name visionboard-github-deploy --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then APP_ID=$(az ad app create --display-name visionboard-github-deploy --query appId -o tsv); fi
az ad sp show --id "$APP_ID" -o none 2>/dev/null || az ad sp create --id "$APP_ID" -o none
# GitHub may present either the classic subject or one with immutable owner/repo ids; trust both.
OWNER_ID=$(gh api "repos/$REPO" --jq .owner.id)
REPO_ID=$(gh api "repos/$REPO" --jq .id)
for pair in "github-main|repo:$REPO:ref:refs/heads/main" \
            "github-main-ids|repo:${REPO%%/*}@$OWNER_ID/${REPO##*/}@$REPO_ID:ref:refs/heads/main"; do
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\":\"${pair%%|*}\",\"issuer\":\"https://token.actions.githubusercontent.com\",
    \"subject\":\"${pair#*|}\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none 2>/dev/null || true
done
RG_ID=$(az group show -n "$RG" --query id -o tsv)
az role assignment create --assignee "$APP_ID" --role Contributor --scope "$RG_ID" -o none 2>/dev/null || true
gh variable set AZURE_CLIENT_ID --repo "$REPO" --body "$APP_ID"
gh variable set AZURE_TENANT_ID --repo "$REPO" --body "$(az account show --query tenantId -o tsv)"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$(az account show --query id -o tsv)"

echo "Done: https://$HOST"
