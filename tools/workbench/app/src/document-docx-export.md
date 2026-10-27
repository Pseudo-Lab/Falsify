# DOCX original-format export

RED binds the imported paragraph text and original file to SHA-256. The exporter re-extracts paragraph text, verifies the binding and each segment offset, and applies the minimal changed span in the original `word/document.xml`. It preserves the unmodified XML characters and the uncompressed contents of other ZIP entries; the ZIP container itself is rebuilt. The source file is never modified. The separate plan records the output hash and verification limitations.

Supported: DOCX with UTF-8 XML, ordinary `w:p`/`w:r`/`w:t` target paragraphs, a unique Before in its segment, and a minimal changed span inside one text element. Before may cross runs when its actual changed span is wholly inside one text element. Tabs, newlines, XML fields, target hyperlinks, tracked changes, changes across text elements, ambiguous boundaries, signed packages, and unusual XML representations are rejected. Other archive entries, including media and relationships, are preserved as data and are not executed or fetched. Archive size, expansion and entry-count checks apply before extraction.

DOCX output is a research copy. Structural checks do not verify page layout, rendering, scientific validity, or independent human review. ODT and HTML remain plan-only. Existing PDF and text export paths are unchanged. SourceBuildVerified is not established by this feature.
