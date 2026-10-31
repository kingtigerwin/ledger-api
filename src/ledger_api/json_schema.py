"""pydantic's JSON Schemas, reshaped for readers that want each schema whole: MCP clients and OpenAPI tools."""

from typing import Any, cast


def inline_defs(schema: dict[str, Any]) -> dict[str, Any]:
    """pydantic puts named types under `$defs`; this puts them back in place, and drops the root's title and doc."""
    defs: dict[str, Any] = schema.get("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            fields = cast(dict[str, Any], node)
            if "$ref" in fields:
                return resolve(defs[str(fields["$ref"]).removeprefix("#/$defs/")])
            return {key: resolve(value) for key, value in fields.items()}
        if isinstance(node, list):
            return [resolve(item) for item in cast(list[Any], node)]
        return node

    return {key: resolve(value) for key, value in schema.items() if key not in ("$defs", "title", "description")}


def without_titles(node: Any) -> Any:
    """Drops the titles pydantic makes up from field names ("Amountcents"); a property named `title` stays."""
    if isinstance(node, dict):
        fields = cast(dict[str, Any], node)
        return {
            key: without_titles(value)
            for key, value in fields.items()
            if not (key == "title" and isinstance(value, str))
        }
    if isinstance(node, list):
        return [without_titles(item) for item in cast(list[Any], node)]
    return node
