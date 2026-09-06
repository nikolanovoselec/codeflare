#!/usr/bin/env python3
"""Apply only the reviewed rclone bookkeeping patch; unknown source fails closed."""
import pathlib
import sys

VERSION = "1.73.5"


def patch(root, version):
    if version != VERSION:
        raise ValueError(f"rclone {version} is not approved for the bisync bookkeeping patch; revalidate before bumping")
    changes = [
        ("backend/s3/s3.go", "\to.setMetaData(head)\n\n\t// Check multipart upload ETag if required", "\to.setMetaData(head)\n\n\tif o.fs.ci.UseServerModTime && (o.fs.opt.NoHead || gotETag == \"\" || head.ETag == nil || strings.Trim(*head.ETag, \"\\\"\") != strings.Trim(gotETag, \"\\\"\")) {\n\t\treturn fmt.Errorf(\"object identity changed after upload; refusing to acknowledge destination metadata\")\n\t}\n\n\t// Check multipart upload ETag if required"),
        ("fs/operations/logger.go", "\tLoggerFn      LoggerFn      // function to use for logging", "\tCopyCompleted func(context.Context, fs.Object, fs.Object) // successful transfer metadata for bisync\n\tLoggerFn      LoggerFn      // function to use for logging"),
        ("fs/operations/copy.go", "\tfs.Infof(c.src, \"%s%s\", actionTaken, fs.LogValueHide(\"size\", fs.SizeSuffix(c.src.Size())))\n\n\treturn newDst, nil", "\tfs.Infof(c.src, \"%s%s\", actionTaken, fs.LogValueHide(\"size\", fs.SizeSuffix(c.src.Size())))\n\n\tif completed := GetLoggerOpt(ctx).CopyCompleted; completed != nil && newDst != nil {\n\t\tcompleted(ctx, c.src, newDst)\n\t}\n\treturn newDst, nil"),
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
          '\treturn f.NewObject(ctx, remote)\n}\n\n// Hashes',
          '\tif f.ci.UseServerModTime {\n'
          '\t\treturn (&Object{fs: f, remote: remote}).completedObject(ctx, etag)\n'
          '\t}\n'
          '\treturn f.NewObject(ctx, remote)\n'
          '}\n'
          '\n'
          '// Hashes'),
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
    originals = {}
    planned = {}
    for name, old, new in changes:
        path = root / name
        if name not in originals:
            originals[name] = path.read_text()
            planned[name] = originals[name]
        if planned[name].count(old) != 1:
            raise ValueError(f"Unrecognized rclone {version} source anchor: {name}; no files patched")
        planned[name] = planned[name].replace(old, new)
    # Validate every anchor before the first write. Version changes require explicit revalidation.
    for name, content in planned.items():
        (root / name).write_text(content)
    return planned


if __name__ == "__main__":
    try:
        patch(pathlib.Path(sys.argv[1]), sys.argv[2])
    except (ValueError, OSError, IndexError) as error:
        sys.exit(str(error))
