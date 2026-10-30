"""The Data table's transactions, as src/data/transactions-store.ts reads and writes them (src/data/data-table.ts)."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


class TransactionsStore:
    def __init__(self, table: "Table") -> None:
        self._table = table
