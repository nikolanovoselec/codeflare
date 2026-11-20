#!/usr/bin/env python3
"""Apply only the reviewed rclone bookkeeping patch; unknown source fails closed."""
import hashlib
import pathlib
import sys

VERSIONS = ("1.73.5", "1.75.2", "1.76.0")

# Exact upstream bytes reviewed with the sequential anchors below.
SOURCE_SHA256 = {
    "1.73.5": {
        "backend/s3/s3.go": "ff8626c3265f7743405104caa77474fbf6e629917a594d378da9abfaa38eea36",
        "cmd/bisync/listing.go": "3a2d2c30e0237057dca6b93b9c711b0629ed2a65af98f188a50067cd2ad7856b",
        "cmd/bisync/queue.go": "e8406ea1fdc7eefb4d15053c4e48b0e2ac98d945bc3175d3f0ca3d552d5178c0",
        "fs/operations/copy.go": "829b1da32ebb1271a3597964e49311423593deb398f7b485bef92b765dfe8642",
        "fs/operations/logger.go": "a5bafdeec3f8544a3ddb4d8a0dcb699c559dea80b73dd9254bdbc99d1236b008",
        "fs/operations/multithread.go": "40f34f5ad9bfe4de3f9983bbf7671323e8eb6ec35b8b029101184605f6c49e36",
    },
    "1.75.2": {
        "backend/s3/s3.go": "291c7199ff896e7f69fcaa15a55708ac8905fb0468c7fb73d082c6b75095413e",
        "cmd/bisync/listing.go": "8adb29fa2b3e85e425c33d3ed61f744f2a37ec9a8a0b86006dd868ae8c755dfe",
        "cmd/bisync/queue.go": "7646b36dae30d0ef20f292b4abb37f1cf251d5f08f3be1f0d35c5d7c0ed2d230",
        "fs/operations/copy.go": "a755ddcc3be9770a23473c63b62bfdc55c8e0650af285ed42002823308319f53",
        "fs/operations/logger.go": "a5bafdeec3f8544a3ddb4d8a0dcb699c559dea80b73dd9254bdbc99d1236b008",
        "fs/operations/multithread.go": "746e5f0cb1b945ef5b14371198fdb617ff71c40a75a2efb95f16f6fa4d73e61c",
    },
    "1.76.0": {
        "backend/s3/s3.go": "3aad01fe43d4d1f952bef03933fd352fbd72c3afce264762d6f6076b3a724a11",
        "cmd/bisync/listing.go": "2e098f48ace4a4ec6debb94850e6ed4eb52f096fe983b6d0160ad3d05d143aeb",
        "cmd/bisync/queue.go": "7646b36dae30d0ef20f292b4abb37f1cf251d5f08f3be1f0d35c5d7c0ed2d230",
        "fs/operations/copy.go": "3a6271c8fda7631881d995233949dad843b87e6a2d7ffbe8c15b2d89f6347d1f",
        "fs/operations/logger.go": "ff5edfe709b14fea6c9196c6f557dfbda60b6225126c862d21f1c262451b6bb1",
        "fs/operations/multithread.go": "e7d0cc08faae17c25861eca0c880e13fe5cc9dbad55115fa575270484a98e365",
    },
}


def patch(root, version):
    if version not in VERSIONS:
        raise ValueError(f"rclone {version} is not approved for the bisync bookkeeping patch; revalidate before bumping")
    if (root / "VERSION").read_text().strip() != f"v{version}":
        raise ValueError("Unreviewed upstream version; revalidate the bookkeeping patch before bumping")
    copy_log = "fs.InfofCtx(ctx, c.src" if version == "1.76.0" else "fs.Infof(c.src"
    changes = [
        ("backend/s3/s3.go", "\to.setMetaData(head)\n\n\t// Check multipart upload ETag if required", "\to.setMetaData(head)\n\n\tif o.fs.ci.UseServerModTime && (o.fs.opt.NoHead || gotETag == \"\" || head.ETag == nil || strings.Trim(*head.ETag, \"\\\"\") != strings.Trim(gotETag, \"\\\"\")) {\n\t\treturn fmt.Errorf(\"object identity changed after upload; refusing to acknowledge destination metadata\")\n\t}\n\n\t// Check multipart upload ETag if required"),
        ("fs/operations/logger.go", "\tLoggerFn      LoggerFn      // function to use for logging", "\tCopyCompleted func(context.Context, fs.Object, fs.Object) // successful transfer metadata for bisync\n\tLoggerFn      LoggerFn      // function to use for logging"),
        ("fs/operations/copy.go", "\t" + copy_log + ", \"%s%s\", actionTaken, fs.LogValueHide(\"size\", fs.SizeSuffix(c.src.Size())))\n\n\treturn newDst, nil", "\t" + copy_log + ", \"%s%s\", actionTaken, fs.LogValueHide(\"size\", fs.SizeSuffix(c.src.Size())))\n\n\tif completed := GetLoggerOpt(ctx).CopyCompleted; completed != nil && newDst != nil {\n\t\tcompleted(ctx, c.src, newDst)\n\t}\n\treturn newDst, nil"),
        ("cmd/bisync/queue.go", "\tresult.Winner = operations.WinningSide(ctx, sigil, src, dst, err)", "\tresult.Winner = operations.WinningSide(ctx, sigil, src, dst, err)\n\tif fs.GetConfig(ctx).UseServerModTime && sigil == operations.Match && dst != nil {\n\t\tresult.Winner = operations.Winner{Obj: dst, Side: \"dst\"}\n\t}"),
        ("cmd/bisync/queue.go", "\tb.queueOpt.logger.LoggerFn = b.WriteResults", "\tb.queueOpt.logger.LoggerFn = b.WriteResults\n\tif b.queueOpt.queueCI.UseServerModTime {\n\t\tb.queueOpt.logger.CopyCompleted = b.WriteCompletedCopy\n\t}"),
        ("cmd/bisync/queue.go", "// ReadResults decodes the JSON data from WriteResults", '''// WriteCompletedCopy records observed destination metadata, not predicted source metadata.
// It runs only after Copy has completed verification, never for dry runs or failures.
func (b *bisyncRun) WriteCompletedCopy(ctx context.Context, src, dst fs.Object) {
	b.queueOpt.lock.Lock()
	defer b.queueOpt.lock.Unlock()
	opt := operations.GetLoggerOpt(ctx)
	for i, side := range []fs.Object{src, dst} {
		result := Results{
			Name: side.Remote(), AltName: altName(side.Remote(), src, dst), Src: FsPathIfAny(src), Dst: FsPathIfAny(dst),
			Size: side.Size(), Modtime: side.ModTime(ctx).In(TZ), Flags: "-",
			IsSrc: i == 0, IsDst: i == 1, IsWinner: i == 1,
			Winner: operations.Winner{Obj: dst, Side: "dst"}, Origin: "copy-completed",
		}
		if !b.queueOpt.ignoreListingChecksum {
			result.Hash, _ = side.Hash(ctx, b.getHashType(side.Fs().Name()))
		}
		if err := json.NewEncoder(opt.JSON).Encode(result); err != nil {
			fs.Errorf(side, "Error recording completed copy: %v", err)
		}
	}
}

// ReadResults decodes the JSON data from WriteResults'''),
        ("cmd/bisync/listing.go", "\t\t\tdstList.put(srcNewName, new.size, new.time, new.hash, new.id, new.flags)", "\t\t\tif completed := dstWinners.get(srcNewName); completed != nil {\n\t\t\t\tdstList.put(srcNewName, completed.size, completed.time, completed.hash, completed.id, completed.flags)\n\t\t\t} else {\n\t\t\t\tdstList.put(srcNewName, new.size, new.time, new.hash, new.id, new.flags)\n\t\t\t}"),
    ]
    changes.extend(
        [('backend/s3/s3.go',
          'src *Object) error {\n\treq.Bucket = &dstBucket',
          'src *Object, etagOut *string) error {\n\treq.Bucket = &dstBucket'),
         ('backend/s3/s3.go',
          'return f.copyMultipart(ctx, req, dstBucket, dstPath, srcBucket, srcPath, src)',
          'return f.copyMultipart(ctx, req, dstBucket, dstPath, srcBucket, srcPath, src, etagOut)'),
         ('backend/s3/s3.go',
          '\t\t_, err := f.c.CopyObject(ctx, req)\n\t\treturn f.shouldRetry(ctx, err)',
          '\t\tresp, err := f.c.CopyObject(ctx, req)\n'
          '\t\tif etagOut != nil && resp != nil && resp.CopyObjectResult != nil {\n'
          '\t\t\t*etagOut = deref(resp.CopyObjectResult.ETag)\n'
          '\t\t}\n'
          '\t\treturn f.shouldRetry(ctx, err)'),
         ('backend/s3/s3.go',
          'src *Object) (err error) {\n\tinfo, err := src.headObject(ctx)',
          'src *Object, etagOut *string) (err error) {\n\tinfo, err := src.headObject(ctx)'),
         ('backend/s3/s3.go',
          '\t\t_, err := f.c.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{',
          '\t\tresp, err := f.c.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{'),
         ('backend/s3/s3.go',
          '\t\t\tIfNoneMatch:          copyReq.IfNoneMatch,\n\t\t})\n\t\treturn f.shouldRetry(ctx, err)',
          '\t\t\tIfNoneMatch:          copyReq.IfNoneMatch,\n'
          '\t\t})\n'
          '\t\tif etagOut != nil && resp != nil {\n'
          '\t\t\t*etagOut = deref(resp.ETag)\n'
          '\t\t}\n'
          '\t\treturn f.shouldRetry(ctx, err)'),
         ('backend/s3/s3.go',
          '\terr = f.copy(ctx, &req, dstBucket, dstPath, srcBucket, srcPath, srcObj)',
          '\tvar etag string\n'
          '\terr = f.copy(ctx, &req, dstBucket, dstPath, srcBucket, srcPath, srcObj, &etag)'),
         ('backend/s3/s3.go',
          ('\treturn f.NewObject(ctx, remote)\n}\n\n// Hashes' if version == "1.73.5" else
           '\tdstObj, err := f.NewObject(ctx, remote)\n\tif err != nil {\n\t\treturn nil, err\n\t}'),
          ('\tif f.ci.UseServerModTime {\n'
           '\t\treturn (&Object{fs: f, remote: remote}).completedObject(ctx, etag)\n'
           '\t}\n'
           '\treturn f.NewObject(ctx, remote)\n'
           '}\n'
           '\n'
           '// Hashes' if version == "1.73.5" else
           '\tvar dstObj fs.Object\n'
           '\tif f.ci.UseServerModTime {\n'
           '\t\tdstObj, err = (&Object{fs: f, remote: remote}).completedObject(ctx, etag)\n'
           '\t} else {\n'
           '\t\tdstObj, err = f.NewObject(ctx, remote)\n'
           '\t}\n'
           '\tif err != nil {\n'
           '\t\treturn nil, err\n'
           '\t}')),
         ('backend/s3/s3.go',
          '\treturn o.fs.copy(ctx, &req, bucket, bucketPath, bucket, bucketPath, o)',
          '\tvar etag string\n'
          '\terr = o.fs.copy(ctx, &req, bucket, bucketPath, bucket, bucketPath, o, &etag)\n'
          '\tif err == nil && o.fs.ci.UseServerModTime {\n'
          '\t\t_, err = o.completedObject(ctx, etag)\n'
          '\t}\n'
          '\treturn err'),
         ('backend/s3/s3.go',
          '\terr = o.fs.copy(ctx, &req, bucket, bucketPath, bucket, bucketPath, o)',
          '\terr = o.fs.copy(ctx, &req, bucket, bucketPath, bucket, bucketPath, o, nil)'),
         ('backend/s3/s3.go',
          'func (w *s3ChunkWriter) Close(ctx context.Context) (err error) {',
          '// CompletedObject reuses the multipart completion identity with the existing post-upload '
          'HEAD.\n'
          'func (w *s3ChunkWriter) CompletedObject(ctx context.Context) (fs.Object, error) {\n'
          '\treturn w.o.completedObject(ctx, w.eTag)\n'
          '}\n'
          '\n'
          'func (o *Object) completedObject(ctx context.Context, etag string) (fs.Object, error) {\n'
          '\thead, err := o.headObject(ctx)\n'
          '\tif err != nil {\n'
          '\t\treturn nil, err\n'
          '\t}\n'
          '\tif o.fs.ci.UseServerModTime && (etag == "" || head.ETag == nil || strings.Trim(*head.ETag, '
          '"\\"") != strings.Trim(etag, "\\"")) {\n'
          '\t\treturn nil, fmt.Errorf("object identity changed after upload; refusing to acknowledge '
          'destination metadata")\n'
          '\t}\n'
          '\to.setMetaData(head)\n'
          '\treturn o, nil\n'
          '}\n'
          '\n'
          'func (w *s3ChunkWriter) Close(ctx context.Context) (err error) {'),
         ('fs/operations/multithread.go',
          '\tobj, err := f.NewObject(ctx, remote)\n'
          '\tif err != nil {\n'
          '\t\treturn nil, fmt.Errorf("multi-thread copy: failed to find object after copy: %w", err)',
          '\tvar obj fs.Object\n'
          '\tif completed, ok := chunkWriter.(interface { CompletedObject(context.Context) (fs.Object, '
          'error) }); ok {\n'
          '\t\tobj, err = completed.CompletedObject(ctx)\n'
          '\t} else {\n'
          '\t\tobj, err = f.NewObject(ctx, remote)\n'
          '\t}\n'
          '\tif err != nil {\n'
          '\t\treturn nil, fmt.Errorf("multi-thread copy: failed to find object after copy: %w", err)')]
    )
    changes.extend([
        ("backend/s3/s3.go", "\n\t// Check multipart upload ETag if required", "\n\tif err := o.completedListingTime(ctx, gotETag); err != nil {\n\t\treturn err\n\t}\n\n\t// Check multipart upload ETag if required"),
        ("backend/s3/s3.go", "\to.setMetaData(head)\n\treturn o, nil\n", "\to.setMetaData(head)\n\tif err := o.completedListingTime(ctx, etag); err != nil {\n\t\treturn nil, err\n\t}\n\treturn o, nil\n"),
        ("backend/s3/s3.go", "func (o *Object) completedObject(", r'''// completedListingTime obtains LIST precision for this completed object only.
// HEAD HTTP dates lose the fractional seconds returned by R2 LIST.
func (o *Object) completedListingTime(ctx context.Context, etag string) error {
 if !o.fs.ci.UseServerModTime { return nil }
 bucket, key := o.split()
 var continuationToken *string
 for {
  var listed *s3.ListObjectsV2Output
  err := o.fs.pacer.Call(func() (bool, error) {
   var err error
   listed, err = o.fs.c.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: &bucket, Prefix: &key, MaxKeys: aws.Int32(1000), ContinuationToken: continuationToken})
   return o.fs.shouldRetry(ctx, err)
  })
  if err != nil { return err }
  if listed == nil { return fmt.Errorf("completed destination missing from exact-key listing") }
  for _, item := range listed.Contents {
   if item.Key == nil || *item.Key != key { continue }
   if item.ETag == nil || etag == "" || strings.Trim(*item.ETag, "\"") != strings.Trim(etag, "\"") || item.Size == nil || *item.Size != o.Size() || item.LastModified == nil {
    return fmt.Errorf("object identity changed after upload; refusing to acknowledge destination metadata")
   }
   o.lastModified = *item.LastModified
   return nil
  }
  if listed.IsTruncated == nil || !*listed.IsTruncated || listed.NextContinuationToken == nil {
   return fmt.Errorf("completed destination missing from exact-key listing")
  }
  continuationToken = listed.NextContinuationToken
 }
 return nil
}

func (o *Object) completedObject('''),
        ("cmd/bisync/listing.go", "\tci := fs.GetConfig(ctx)\n\tupdateLists :=", ''' // Verified completions override speculative records regardless of logger order.
 completedSrc, completedDst := newFileList(), newFileList()
 for _, result := range results {
  if result.Origin != "copy-completed" || result.Err != nil || result.Winner.Err != nil { continue }
  winners, completed := dstWinners, completedDst
  if result.IsSrc { winners, completed = srcWinners, completedSrc }
  winners.put(result.Name, result.Size, result.Modtime, result.Hash, "-", result.Flags)
  winners.get(result.Name).time = result.Modtime
  completed.put(result.Name, result.Size, result.Modtime, result.Hash, "-", result.Flags)
 }
	ci := fs.GetConfig(ctx)
	updateLists :='''),
        ("cmd/bisync/listing.go", "\t\t\t\tnew := winners.get(queueFile)\n", "\t\t\t\tnew := winners.get(queueFile)\n\t\t\t\tverified := completedSrc.has(queueFile)\n\t\t\t\tif side == \"dst\" { verified = completedDst.has(queueFile) }\n"),
        ("cmd/bisync/listing.go", "\t\t\t\tlist.put(queueFile, new.size, new.time, new.hash, new.id, new.flags)\n", "\t\t\t\tlist.put(queueFile, new.size, new.time, new.hash, new.id, new.flags)\n\t\t\t\tif verified { list.get(queueFile).time = new.time }\n"),
        ("cmd/bisync/listing.go", "\t\t\t\tdstList.put(srcNewName, completed.size, completed.time, completed.hash, completed.id, completed.flags)", "\t\t\t\tdstList.put(srcNewName, completed.size, completed.time, completed.hash, completed.id, completed.flags)\n\t\t\t\tif completedDst.has(srcNewName) { dstList.get(srcNewName).time = completed.time }"),
    ])
    originals = {}
    planned = {}
    for name, old, new in changes:
        path = root / name
        if name not in originals:
            originals[name] = path.read_bytes().decode()
            planned[name] = originals[name]
        if planned[name].count(old) != 1:
            raise ValueError(f"Unrecognized rclone {version} source anchor: {name}; no files patched")
        planned[name] = planned[name].replace(old, new)
    # Anchors and exact bytes must all pass before the first write.
    for name, content in originals.items():
        if hashlib.sha256(content.encode()).hexdigest() != SOURCE_SHA256[version][name]:
            raise ValueError(f"Unreviewed rclone {version} source digest: {name}; no files patched")
    for name, content in planned.items():
        (root / name).write_text(content)
    return planned


if __name__ == "__main__":
    try:
        patch(pathlib.Path(sys.argv[1]), sys.argv[2])
    except (ValueError, OSError, IndexError) as error:
        sys.exit(str(error))
