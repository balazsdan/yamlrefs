# YAML Reference Resolver

This VS Code extension validates and navigates configurable references in YAML files. Definitions may come from the edited YAML document, its transitive `$include` graph, or configured external JSON and INI files.

Place `.yamlrefs.json` in the root of the VS Code workspace.

## Examples

Open either [examples/includes](examples/includes) or [examples/external-sources](examples/external-sources) as the VS Code workspace root. The first demonstrates internal definitions across transitive `$include` files; the second loads definitions from JSON and INI files.

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

## External JSON definitions

External JSON definitions use the same path-glob syntax as internal YAML definitions. Each path is matched independently in every JSON file selected by `files`.

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
        "type": "json",
        "files": [
          "settings/**/*.json"
        ],
        "paths": [
          "/components/*/id"
        ]
      }
    }
  }
}
```

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
- Go to Definition from `$include` filenames and YAML references, including the source value range for external definitions.
- Automatic refresh after configuration, YAML, JSON, or INI changes.
