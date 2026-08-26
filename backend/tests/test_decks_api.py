import unittest

try:
    from fastapi import HTTPException
    from pydantic import ValidationError
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.decks import add_deck_entry, create_deck, delete_deck, delete_deck_entry, get_deck, update_deck, update_deck_entry
    from database import Base
    from models import Card, CollectionItem, Deck, DeckEntry, User
    from schemas import DeckCreate, DeckEntryCreate, DeckEntryUpdate, DeckUpdate
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class DeckApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.card = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Pikachu ex", set_id="sv1", number="1", lang="en", supertype="Pokemon", variants_normal=True)
        self.energy = Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Basic Lightning Energy", set_id="sv1", number="2", lang="en", supertype="Energy", subtypes=["Basic"], variants_normal=True)
        self.db.add_all([self.user, self.other_user, self.card, self.energy])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

    def tearDown(self):
        self.db.close()

    def _own(self, card_id, quantity, variant="Normal", condition="NM"):
        item = CollectionItem(card_id=card_id, user_id=self.user.id, quantity=quantity, variant=variant, condition=condition, lang="en")
        self.db.add(item)
        self.db.commit()
        return item

    def _create(self, target_size=60):
        return create_deck(DeckCreate(name="Practice", target_size=target_size), current_user=self.user, db=self.db)

    def test_creates_20_40_and_60_card_decks(self):
        for target_size in (20, 40, 60):
            deck = self._create(target_size)
            self.assertEqual(deck.target_size, target_size)
            self.assertEqual(deck.status, "under")
            self.assertEqual(deck.remaining_to_target, target_size)

    def test_invalid_target_size_is_rejected(self):
        with self.assertRaises(ValidationError):
            DeckCreate(name="Invalid", target_size=30)

    def test_rename_and_change_target_size_preserves_entries(self):
        self._own(self.card.id, 2)
        deck = self._create(20)
        updated = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=2), current_user=self.user, db=self.db)
        updated = update_deck(deck.id, DeckUpdate(name="Renamed", target_size=40), current_user=self.user, db=self.db)
        self.assertEqual(updated.name, "Renamed")
        self.assertEqual(updated.target_size, 40)
        self.assertEqual(updated.current_card_count, 2)
        self.assertEqual(len(updated.entries), 1)

    def test_entry_quantity_counts_ownership_and_shortage(self):
        self._own(self.card.id, 1, variant="Normal")
        self._own(self.card.id, 2, variant="Reverse Holo", condition="LP")
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=4), current_user=self.user, db=self.db)
        entry = result.entries[0]
        self.assertEqual(result.current_card_count, 4)
        self.assertEqual(entry.owned_quantity, 3)
        self.assertEqual(entry.shortage, 1)
        self.assertEqual(result.missing_copy_count, 1)

    def test_existing_entry_can_exceed_ownership(self):
        self._own(self.card.id, 1)
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=1), current_user=self.user, db=self.db)
        result = update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=7), current_user=self.user, db=self.db)
        self.assertEqual(result.entries[0].required_quantity, 7)
        self.assertEqual(result.entries[0].shortage, 6)

    def test_remove_entry_and_delete_deck_cascade_entries(self):
        self._own(self.card.id, 2)
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=2), current_user=self.user, db=self.db)
        delete_deck_entry(deck.id, result.entries[0].id, current_user=self.user, db=self.db)
        self.assertEqual(self.db.query(DeckEntry).count(), 0)
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id), current_user=self.user, db=self.db)
        delete_deck(deck.id, current_user=self.user, db=self.db)
        self.assertEqual(self.db.query(Deck).count(), 0)
        self.assertEqual(self.db.query(DeckEntry).count(), 0)

    def test_other_user_cannot_access_deck_or_entry(self):
        self._own(self.card.id, 1)
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id), current_user=self.user, db=self.db)
        with self.assertRaises(HTTPException) as access:
            get_deck(deck.id, current_user=self.other_user, db=self.db)
        self.assertEqual(access.exception.status_code, 404)
        with self.assertRaises(HTTPException) as entry_access:
            update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=2), current_user=self.other_user, db=self.db)
        self.assertEqual(entry_access.exception.status_code, 404)

    def test_basic_energy_is_excluded_from_copy_limit_warning(self):
        self._own(self.card.id, 6)
        self._own(self.energy.id, 6)
        deck = self._create()
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=5), current_user=self.user, db=self.db)
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.energy.id, required_quantity=5), current_user=self.user, db=self.db)
        self.assertEqual(result.copy_limit_warnings[0].name, "Pikachu ex")
        self.assertEqual(len(result.copy_limit_warnings), 1)


if __name__ == "__main__":
    unittest.main()
