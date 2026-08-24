# YAML Reference Resolver

This VS Code extension validates and navigates configurable references in YAML files. Definitions may come from the edited YAML document, its transitive `$include` graph, or configured external INI files.

Place `.yamlrefs.json` in the root of the VS Code workspace.

## Internal definitions

Internal definitions are visible only from the edited YAML document and YAML files reachable through `$include`.

```json
{
  "version": 1,
  "definitions": {
    "component": {
      "paths": [
        "/components/*/id"
      ],
      "references": [
        "/pages/*/componentIds/*"
      ]
    }
  },
  "externalDefinitions": {}
}
```

YAML path globs start at the document root. `*` matches one key or array index, `**` matches any depth, and `{A,B}` matches alternatives.

## Includes

`$include` must be a root-level list, including when only one file is included:

```yaml
$include:
  - ./components.yaml
  - ./pages.yaml
```

Paths are relative to the including file. Includes are transitive, and missing files or cycles produce diagnostics.

## External INI definitions

```json
{
  "version": 1,
  "definitions": {},
  "externalDefinitions": {
    "theme": {
      "references": [
        "/pages/*/theme"
      ],
      "source": {
        "type": "ini",
        "files": [
          "settings/**/*.ini"
        ],
        "sections": [
          "Themes"
        ],
        "keys": [
          "+Name"
        ],
        "from": "value"
      }
    }
  }
}
```

Given:

```ini
[Themes]
+Name=light
+Name=dark
```

the two theme names are available for completion and Go to Definition. Repeated keys are preserved. `from` may be `key` or `value`; an optional `pattern` regular expression can extract a value from a structured entry. A named `value` group is preferred, followed by the first capture or full match.

## Editor features

- Diagnostics for unknown references, invalid includes, missing includes, cycles, and source failures.
- Completion for existing values, empty mapping values, and empty sequence items.
- Go to Definition from `$include` filenames and YAML references, including the exact INI key/value range for external definitions.
- Automatic refresh after configuration, YAML, or INI changes.
