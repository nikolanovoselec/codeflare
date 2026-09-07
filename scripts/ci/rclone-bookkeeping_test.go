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
 "github.com/rclone/rclone/cmd/bisync/bilib"
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
 // REQ-STOR-042 / REQ-STOR-043: independent timestamps and successful-transfer-only bookkeeping.
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
 // Verify persisted listings, including an older-in-the-same-second completion.
 for _, completionFirst := range []bool{false, true} {
  b.opt = &Options{IgnoreListingChecksum: true, Compare: CompareOpt{Modtime: true, Size: true}}
  b.listing1, b.listing2 = filepath.Join(t.TempDir(), "path1.lst"), filepath.Join(t.TempDir(), "path2.lst")
  actual := destinationTime.Truncate(time.Second).Add(100 * time.Millisecond)
  speculative := actual.Add(400 * time.Millisecond)
  for _, path := range []string{b.listing1, b.listing2} {
   initial := newFileList(); initial.put(name, 9, speculative, "", "-", "-")
   if err := initial.save(path); err != nil { t.Fatal(err) }
  }
  completed := append([]Results(nil), records...)
  completed[1].Modtime = actual
  predicted := completed[0]; predicted.Origin = "sync"; predicted.IsWinner = true
  predicted.Modtime = speculative; predicted.Winner.Side = "src"
  ordered := append([]Results{predicted}, completed...)
  if completionFirst { ordered = append(completed, predicted) }
  q := queues{copy1to2: bilib.Names{name: nil}, skippedDirs1: newFileList(), skippedDirs2: newFileList()}
  if err := b.modifyListing(ctx, srcFs, dstFs, ordered, q, true); err != nil { t.Fatal(err) }
  left, err := b.loadListing(b.listing1); if err != nil { t.Fatal(err) }
  right, err := b.loadListing(b.listing2); if err != nil { t.Fatal(err) }
  if !left.get(name).time.Equal(sourceTime) || !right.get(name).time.Equal(actual) {
   t.Fatalf("completionFirst=%v: persisted timestamps differ: %v / %v", completionFirst, left.get(name).time, right.get(name).time)
  }
 }
 // An interrupted transfer must not emit successful baseline records.
 results.Reset(); dst.fail = true
 if _, err := operations.Copy(ctx, dst, nil, "failed.jsonl", src); err == nil { t.Fatal("expected upload failure") }
 if results.Len() != 0 { t.Fatal("failed upload advanced bookkeeping") }
 // Dry runs must not acknowledge an upload either.
 ci.DryRun = true; dst.fail = false
 if _, err := operations.Copy(ctx, dst, nil, "dry.jsonl", src); err != nil { t.Fatal(err) }
 if results.Len() != 0 { t.Fatal("dry run advanced bookkeeping") }
}
