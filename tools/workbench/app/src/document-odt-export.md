# Original ODT export contract

RED exports an experimental ODT copy only when the original file hash, extracted text hash, segments and exact unique offsets still match. Changes are limited to a minimal span within one plain text run in a `text:p` or `text:h`, including a simple `text:span`. Entity and Unicode boundaries are checked. Complex paragraphs, ambiguous or cross-run edits, unsupported control characters, encrypted or signed packages, scripts and DTDs are refused. All other entry contents and `content.xml` bytes outside edited spans are preserved; ZIP compression bytes may change. The output puts the `mimetype` entry first and stores it uncompressed. Visual layout and reflow are not verified. SourceBuildVerified remains false.

`node tests/document-odt-export.spec.cjs` exercises a synthetic RED request, candidate selection and download, entry preservation and an independent ZIP/XML check. No model or remote paper is used.
