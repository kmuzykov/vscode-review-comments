# `.vscode/review-comments.json`

Location: `<first workspace folder>/.vscode/review-comments.json`. The extension creates the `.vscode` folder if needed, rewrites the whole file on every change it makes, and reloads the whole file whenever anything else writes it.

## Schema

```
{
  "threads": [
    {
      "id": string,              // unique within the file
      "filePath": string,        // workspace-relative, forward slashes, e.g. "src/app.py"
      "range": {
        "startLine": number,     // zero-based; editor shows startLine + 1
        "endLine": number        // zero-based, inclusive
      },
      "resolved": boolean,
      "comments": [
        {
          "id": string,
          "author": string,      // "User" for the human; your product name for you
          "body": string,        // plain text or markdown
          "timestamp": string    // ISO 8601, e.g. "2026-09-02T09:14:03.512Z"
        }
      ]
    }
  ]
}
```

A thread with no comments is invalid; the extension never writes one. If the file contains threads it cannot show (missing `id`, `filePath`, `range.startLine` or comments, or a duplicate `id`), it warns, skips them on screen and leaves them in the file untouched. If the whole file is not valid JSON, the editor keeps the last good version and refuses to save until it is fixed, so re-parse after every write.

## Example

Two threads in one file. The first is pending for the agent (last comment by `User`). The second was answered and is now waiting for the human to resolve.

```json
{
  "threads": [
    {
      "id": "k3f9a2x1mf0q7",
      "filePath": "src/ingest/chunker.py",
      "range": { "startLine": 41, "endLine": 47 },
      "resolved": false,
      "comments": [
        {
          "id": "p8d2s0n4mf0q7",
          "author": "User",
          "body": "This loop re-tokenises every chunk. Cache the tokenizer call per document.",
          "timestamp": "2026-09-02T09:14:03.512Z"
        }
      ]
    },
    {
      "id": "z7q1w9e3mf0m2",
      "filePath": "src/ingest/chunker.py",
      "range": { "startLine": 12, "endLine": 12 },
      "resolved": false,
      "comments": [
        {
          "id": "a1b2c3d4mf0m2",
          "author": "User",
          "body": "Why 512 here and not the model's max?",
          "timestamp": "2026-09-02T09:11:40.002Z"
        },
        {
          "id": "q9w8e7r6mf0n1",
          "author": "Claude",
          "body": "512 is the embedding model's recommended input, not its hard limit (8192). Longer chunks measurably hurt retrieval in the corpus v3 eval. Left as is; happy to make it a config value if you want to experiment.",
          "timestamp": "2026-09-02T09:20:15.771Z"
        }
      ]
    }
  ]
}
```

## Pending rule

```
pending = not thread.resolved and thread.comments[-1].author != MY_AUTHOR_NAME
```

## Writing the file

Read, parse, modify the object, serialise with two-space indentation and a trailing newline, write the whole file. Keep unknown fields. Do not append text or edit with regular expressions; the extension parses the full document and a broken file shows up as "no comments" in the editor with no error.
