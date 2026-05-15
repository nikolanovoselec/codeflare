---
source_file: "src/routes/storage/validation.ts"
type: "code"
community: "Container Health Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Container_Health_Routes
---

# validateKey - path traversal + protected path + URI decode guard

## Connections
- [[initiate, part, complete, abort multipart upload endpoints]] - `calls` [EXTRACTED]
- [[GET apistoragebrowse - ListObjectsV2 with auto-bucket-create + seed]] - `calls` [EXTRACTED]
- [[GET apistoragedownload - signed R2 fetch, streamed via worker]] - `calls` [EXTRACTED]
- [[GET apistoragepreview - HEAD then inline text or metadata]] - `calls` [EXTRACTED]
- [[POST apistoragedelete - batch keys + prefix-tree delete]] - `calls` [EXTRACTED]
- [[POST apistorageupload - simple base64 upload to R2]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Container_Health_Routes