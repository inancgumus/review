import assert from "node:assert/strict";
import test from "node:test";
import { parseAnnotations } from "../diff-review.ts";

const DIFF = `# Review: abc1234 Fix auth
#
# Type comments on a new line below the code you're commenting on.
# No comments = approve. Save and close when done.

diff --git a/auth.go b/auth.go
--- a/auth.go
+++ b/auth.go
@@ -10,6 +10,8 @@
 func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
     token := r.Header.Get("Authorization")
+    if token == "" {
+        w.WriteHeader(401)
     }
`;

test("parseAnnotations: no comments = no annotations", () => {
	const result = parseAnnotations(DIFF, DIFF);
	assert.equal(result.length, 0);
});

test("parseAnnotations: single line comment", () => {
	const edited = DIFF.replace(
		"+    if token == \"\" {",
		"+    if token == \"\" {\nneed real token validation here",
	);
	const result = parseAnnotations(DIFF, edited);
	assert.equal(result.length, 1);
	assert.equal(result[0].file, "auth.go");
	assert.equal(result[0].endLine, 12);
	assert.match(result[0].comment, /need real token validation/);
});

test("parseAnnotations: range annotation with empty line separator", () => {
	const edited = DIFF.replace(
		"+    if token == \"\" {\n+        w.WriteHeader(401)",
		"+    if token == \"\" {\n\n+        w.WriteHeader(401)\nthis whole block needs rework",
	);
	const result = parseAnnotations(DIFF, edited);
	assert.equal(result.length, 1);
	assert.ok(result[0].startLine < result[0].endLine || result[0].startLine === result[0].endLine, "range should span lines");
	assert.match(result[0].comment, /this whole block/);
});

test("parseAnnotations: multiple comments on different files", () => {
	const multiDiff = `# Review
#

diff --git a/a.go b/a.go
--- a/a.go
+++ b/a.go
@@ -1,3 +1,4 @@
 package main
+import "fmt"
 func main() {
diff --git a/b.go b/b.go
--- a/b.go
+++ b/b.go
@@ -1,3 +1,4 @@
 package main
+import "os"
 func init() {
`;
	const edited = multiDiff.replace(
		'+import "fmt"',
		'+import "fmt"\nunused import',
	).replace(
		'+import "os"',
		'+import "os"\nalso unused',
	);
	const result = parseAnnotations(multiDiff, edited);
	assert.equal(result.length, 2);
	assert.equal(result[0].file, "a.go");
	assert.match(result[0].comment, /unused import/);
	assert.equal(result[1].file, "b.go");
	assert.match(result[1].comment, /also unused/);
});
