"""
The two tables' key schemas, for the stack; tests/integration/conftest.py builds its tables to match.

Users table:

    pk                      sk          item
    USER#<userId>           PROFILE     the user: username, email, password hash, status, role, lockout state
    USERNAME#<lowercase>    USERNAME    claims a username so two users can't share it

When emails are on, it streams old and new images to the notify Lambda.

Data table, where everything a customer owns lives under their partition, so a query can never cross customers:

    pk              sk                   item
    USER#<userId>   TXN#<date>#<txnId>   a transaction
    USER#<userId>   TXNREF#<txnId>       points at the transaction's date, so it can be found by ID

Its indexes are both sorted by `<date>#<txnId>`:

    byCategory (gsi2pk = USER#<userId>#CATEGORY#<category>): one customer's transactions in a category.
      It keeps the gsi2 names it had when a by-member index (gsi1) existed: renaming would replace the index.
    allByDate (gsi3pk = TXN): every customer's transactions, for the admin. One partition is plenty
      at household scale; it would need sharding by month if writes ever got near 1,000/second.
"""

from dataclasses import dataclass

PARTITION_KEY = "pk"
SORT_KEY = "sk"


@dataclass(frozen=True)
class TableIndex:
    name: str
    partition_key: str
    sort_key: str


DATA_TABLE_INDEXES = (TableIndex("byCategory", "gsi2pk", "gsi2sk"), TableIndex("allByDate", "gsi3pk", "gsi3sk"))
