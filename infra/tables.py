"""Key schemas of the two tables, for the stack; tests/integration/conftest.py builds its tables to match."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Index:
    name: str
    partition_key: str
    sort_key: str


# Both tables.
PARTITION_KEY = "pk"
SORT_KEY = "sk"

# The Users table.
#
#   pk                      sk          item
#   USER#<userId>           PROFILE     the user: username, email, password hash, status, role, lockout state
#   USERNAME#<lowercase>    USERNAME    claims a username so two users can't share it
#
# When emails are on, the table streams old and new images to the notify Lambda.

# The Data table. Everything a customer owns lives under their partition, so a query can never cross customers.
#
#   pk              sk                   item
#   USER#<userId>   TXN#<date>#<txnId>   a transaction
#   USER#<userId>   TXNREF#<txnId>       points at the transaction's date, so it can be found by ID
#
# Indexes, both sorted by `<date>#<txnId>`:
#   byCategory (gsi2pk = USER#<userId>#CATEGORY#<category>): one customer's transactions in a category.
#     It keeps the gsi2 names it had when a by-member index (gsi1) existed: renaming would replace the index.
#   allByDate (gsi3pk = TXN): every customer's transactions, for the admin. One partition is plenty
#     at household scale; it would need sharding by month if writes ever got near 1,000/second.
DATA_INDEXES = (
    Index(name="byCategory", partition_key="gsi2pk", sort_key="gsi2sk"),
    Index(name="allByDate", partition_key="gsi3pk", sort_key="gsi3sk"),
)
