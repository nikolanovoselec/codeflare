---
source_file: "src/lib/user-cleanup.ts"
type: "code"
community: "Community 173"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Community_173
---

# cleanupUserData (sessions + containers + KV + R2 token + bucket teardown)

## Connections
- [[CF_API_BASE Cloudflare API URL]] - `references` [EXTRACTED]
- [[SETUP_KEYS constants (setup KV key registry)]] - `references` [EXTRACTED]
- [[createR2Client (aws4fetch AwsClient for R2 S3 API)]] - `calls` [EXTRACTED]
- [[deleteScopedR2Token]] - `calls` [EXTRACTED]
- [[emptyR2Bucket (paginated S3 list + multi-delete)]] - `calls` [EXTRACTED]
- [[getBucketName (email-to-R2-bucket-name sanitization, 63 char max)]] - `shares_data_with` [EXTRACTED]
- [[getSessionPrefix]] - `calls` [EXTRACTED]
- [[listAllKvKeys (paginated KV.list, MAX 100 iterations)]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Community_173