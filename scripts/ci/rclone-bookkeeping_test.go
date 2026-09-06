package bisync

import (
 "bytes"
 "context"
 "fmt"
 "io"
 "os"
 "path/filepath"
 "testing"
 "time"

 _ "github.com/rclone/rclone/backend/local"
 "github.com/rclone/rclone/fs"
 "github.com/rclone/rclone/fs/operations"
)

type serverTimeObject struct { fs.Object; timestamp time.Time }
func (o serverTimeObject) ModTime(context.Context) time.Time { return o.timestamp }
type serverTimeFs struct { fs.Fs; timestamp time.Time; fail bool; puts int }
func (f *serverTimeFs) Features() *fs.Features { return &fs.Features{} }
func (f *serverTimeFs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, opts ...fs.OpenOption) (fs.Object, error) {
 f.puts++
 if f.fail { return nil, fmt.Errorf("fixture upload interrupted") }
 o, err := f.Fs.Put(ctx, in, src, opts...)
 if err != nil { return nil, err }
 return serverTimeObject{o, f.timestamp}, nil
}

func TestCodeflareCompletedCopyKeepsIndependentMetadata(t *testing.T) {
 // REQ-STOR-040: independent timestamps and successful-transfer-only bookkeeping.
 ctx, ci := fs.AddConfig(context.Background())
 ci.UseServerModTime = true
 ci.LowLevelRetries = 1
 sourceDir, destDir := t.TempDir(), t.TempDir()
 name := "session.jsonl"
 if err := os.WriteFile(filepath.Join(sourceDir, name), []byte("original\n"), 0600); err != nil { t.Fatal(err) }
 srcFs, err := fs.NewFs(ctx, sourceDir); if err != nil { t.Fatal(err) }
 dstFs, err := fs.NewFs(ctx, destDir); if err != nil { t.Fatal(err) }
 src, err := srcFs.NewObject(ctx, name); if err != nil { t.Fatal(err) }
 sourceTime := src.ModTime(ctx)
 destinationTime := sourceTime.Add(time.Minute)
 dst := &serverTimeFs{Fs: dstFs, timestamp: destinationTime}
 b := &bisyncRun{}
 b.queueOpt.ignoreListingChecksum = true
 var results bytes.Buffer
 ctx = operations.WithSyncLogger(ctx, operations.LoggerOpt{JSON: &results, LoggerFn: b.WriteResults, CopyCompleted: b.WriteCompletedCopy})
 if _, err := operations.Copy(ctx, dst, nil, name, src); err != nil { t.Fatal(err) }
 records := ReadResults(&results)
 if len(records) != 2 { t.Fatalf("want two completion records, got %d", len(records)) }
 if !records[0].Modtime.Equal(sourceTime) || !records[1].Modtime.Equal(destinationTime) { t.Fatalf("source/destination timestamps conflated: %+v", records) }
 if records[0].IsWinner || !records[1].IsWinner { t.Fatal("destination baseline must use completed destination") }
 if records[0].Size != 9 || records[1].Size != 9 || dst.puts != 1 { t.Fatal("unexpected transfer size/count") }
 if err := os.WriteFile(filepath.Join(sourceDir, name), []byte("original\nappend\n"), 0600); err != nil { t.Fatal(err) }
 current, err := srcFs.NewObject(ctx, name); if err != nil { t.Fatal(err) }
 if records[0].Size == current.Size() { t.Fatal("later append was acknowledged prematurely") }
 // An interrupted transfer must not emit successful baseline records.
 results.Reset(); dst.fail = true
 if _, err := operations.Copy(ctx, dst, nil, "failed.jsonl", src); err == nil { t.Fatal("expected upload failure") }
 if results.Len() != 0 { t.Fatal("failed upload advanced bookkeeping") }
 // Dry runs must not acknowledge an upload either.
 ci.DryRun = true; dst.fail = false
 if _, err := operations.Copy(ctx, dst, nil, "dry.jsonl", src); err != nil { t.Fatal(err) }
 if results.Len() != 0 { t.Fatal("dry run advanced bookkeeping") }
}
