import re

from ledger_api.auth.password import hash_password, verify_password

# Made by the TypeScript auth Lambda (src/auth/password.ts) from "café": the hashes already in the Users table.
NODE_HASH = "scrypt$131072$8$1$Vlyvx/AF7riDthYGBqeY6g==$fbRd/JilVkzj9xWMlNrr9r3mdv1rylX3Fksz10pD28c="


class TestGivenAHashedPassword:
    def test_it_verifies_the_same_password(self) -> None:
        assert verify_password("correct horse", hash_password("correct horse"))

    def test_it_rejects_a_different_password(self) -> None:
        assert not verify_password("wrong horse", hash_password("correct horse"))

    def test_it_stores_the_scrypt_settings_and_a_fresh_salt_each_time(self) -> None:
        a, b = hash_password("pw"), hash_password("pw")

        assert re.fullmatch(r"scrypt\$131072\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+", a)
        assert a != b

    def test_it_treats_composed_and_decomposed_unicode_as_the_same_password(self) -> None:
        assert verify_password("café", hash_password("café"))


class TestGivenAHashTheTypeScriptLambdaMade:
    def test_it_verifies_the_password_whichever_way_its_unicode_is_composed(self) -> None:
        assert verify_password("café", NODE_HASH)
        assert verify_password("café", NODE_HASH)

    def test_it_rejects_a_different_password(self) -> None:
        assert not verify_password("cafe", NODE_HASH)


class TestGivenSomethingThatIsNotAScryptHash:
    def test_it_rejects_every_password(self) -> None:
        assert not verify_password("pw", "bcrypt$whatever")
        assert not verify_password("pw", "scrypt$...")
