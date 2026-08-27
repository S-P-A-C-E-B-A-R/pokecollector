import unittest
from types import SimpleNamespace

from services.deck_allocation import allocation_for_decks


def deck(deck_id, state, quantity):
    return SimpleNamespace(id=deck_id, name=f"Deck {deck_id}", inventory_state=state, entries=[SimpleNamespace(card_id="ultra", required_quantity=quantity)])


class DeckAllocationTests(unittest.TestCase):
    def test_reserved_decks_share_card_id_pool_without_self_subtraction(self):
        a, b = deck(1, "reserved", 3), deck(2, "reserved", 4)
        self.assertEqual(allocation_for_decks([a, b], {"ultra": 6}, 1)["ultra"]["available_to_this_deck"], 2)
        self.assertEqual(allocation_for_decks([a, b], {"ultra": 6}, 2)["ultra"]["available_to_this_deck"], 3)

    def test_planning_decks_do_not_reserve(self):
        a, b, c = deck(1, "reserved", 3), deck(2, "reserved", 4), deck(3, "planning", 4)
        result = allocation_for_decks([a, b, c], {"ultra": 6}, 1)["ultra"]
        self.assertEqual((result["reserved_total"], result["conflict"]), (7, 1))


if __name__ == "__main__":
    unittest.main()
