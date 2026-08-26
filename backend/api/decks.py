import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from database import get_db
from models import Card, CollectionItem, Deck, DeckEntry, User
from schemas import DeckCreate, DeckEntryCreate, DeckEntryUpdate, DeckResponse, DeckUpdate

router = APIRouter()


def _deck_or_404(db: Session, deck_id: int, user_id: int, with_entries: bool = False) -> Deck:
    query = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == user_id)
    if with_entries:
        query = query.options(joinedload(Deck.entries).joinedload(DeckEntry.card).joinedload(Card.set_ref))
    deck = query.first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return deck


def _owned_quantities(db: Session, user_id: int, card_ids: list[str]) -> dict[str, int]:
    if not card_ids:
        return {}
    return {
        card_id: int(quantity or 0)
        for card_id, quantity in db.query(
            CollectionItem.card_id,
            func.coalesce(func.sum(CollectionItem.quantity), 0),
        ).filter(
            CollectionItem.user_id == user_id,
            CollectionItem.card_id.in_(card_ids),
        ).group_by(CollectionItem.card_id).all()
    }


def _copy_limit_warnings(entries: list[DeckEntry]) -> list[dict]:
    """Warn only when every printing in a name group has usable gameplay metadata."""
    groups: dict[str, list[DeckEntry]] = {}
    for entry in entries:
        if entry.card and entry.card.name:
            groups.setdefault(entry.card.name, []).append(entry)

    warnings = []
    for name, named_entries in groups.items():
        cards = [entry.card for entry in named_entries]
        if any(not card or not card.supertype for card in cards):
            continue
        is_basic_energy = all(
            card.supertype.lower() == "energy"
            and any(str(subtype).lower() == "basic" for subtype in (card.subtypes or []))
            for card in cards
        )
        quantity = sum(int(entry.required_quantity or 0) for entry in named_entries)
        if quantity > 4 and not is_basic_energy:
            warnings.append({"name": name, "quantity": quantity})
    return sorted(warnings, key=lambda warning: warning["name"].lower())


def _deck_response(deck: Deck, owned_quantities: dict[str, int] | None = None, include_entries: bool = True) -> DeckResponse:
    entries = list(deck.entries) if include_entries else []
    if owned_quantities is None:
        owned_quantities = {}
    current_card_count = sum(int(entry.required_quantity or 0) for entry in entries)
    missing_copy_count = sum(
        max(int(entry.required_quantity or 0) - int(owned_quantities.get(entry.card_id, 0)), 0)
        for entry in entries
    )
    if current_card_count < deck.target_size:
        status = "under"
    elif current_card_count > deck.target_size:
        status = "over"
    else:
        status = "complete"

    return DeckResponse(
        id=deck.id,
        name=deck.name,
        target_size=deck.target_size,
        description=deck.description,
        created_at=deck.created_at,
        updated_at=deck.updated_at,
        current_card_count=current_card_count,
        remaining_to_target=max(deck.target_size - current_card_count, 0),
        over_target_by=max(current_card_count - deck.target_size, 0),
        missing_copy_count=missing_copy_count,
        status=status,
        entries=[
            {
                "id": entry.id,
                "card_id": entry.card_id,
                "required_quantity": entry.required_quantity,
                "owned_quantity": int(owned_quantities.get(entry.card_id, 0)),
                "shortage": max(entry.required_quantity - int(owned_quantities.get(entry.card_id, 0)), 0),
                "card": entry.card,
            }
            for entry in entries
        ],
        copy_limit_warnings=_copy_limit_warnings(entries),
    )


@router.get("/", response_model=list[DeckResponse])
def get_decks(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    decks = db.query(Deck).filter(Deck.user_id == current_user.id).order_by(Deck.updated_at.desc(), Deck.id.desc()).all()
    if not decks:
        return []

    deck_ids = [deck.id for deck in decks]
    totals = {
        deck_id: int(quantity or 0)
        for deck_id, quantity in db.query(DeckEntry.deck_id, func.coalesce(func.sum(DeckEntry.required_quantity), 0)).filter(
            DeckEntry.deck_id.in_(deck_ids)
        ).group_by(DeckEntry.deck_id).all()
    }
    owned = db.query(
        CollectionItem.card_id.label("card_id"),
        func.coalesce(func.sum(CollectionItem.quantity), 0).label("owned_quantity"),
    ).filter(CollectionItem.user_id == current_user.id).group_by(CollectionItem.card_id).subquery()
    shortages = {
        deck_id: int(quantity or 0)
        for deck_id, quantity in db.query(
            DeckEntry.deck_id,
            func.coalesce(func.sum(case(
                (DeckEntry.required_quantity > func.coalesce(owned.c.owned_quantity, 0),
                 DeckEntry.required_quantity - func.coalesce(owned.c.owned_quantity, 0)),
                else_=0,
            )), 0),
        ).outerjoin(owned, DeckEntry.card_id == owned.c.card_id).filter(
            DeckEntry.deck_id.in_(deck_ids)
        ).group_by(DeckEntry.deck_id).all()
    }
    responses = []
    for deck in decks:
        current_card_count = totals.get(deck.id, 0)
        status = "under" if current_card_count < deck.target_size else "over" if current_card_count > deck.target_size else "complete"
        responses.append(DeckResponse(
            id=deck.id,
            name=deck.name,
            target_size=deck.target_size,
            description=deck.description,
            created_at=deck.created_at,
            updated_at=deck.updated_at,
            current_card_count=current_card_count,
            remaining_to_target=max(deck.target_size - current_card_count, 0),
            over_target_by=max(current_card_count - deck.target_size, 0),
            missing_copy_count=shortages.get(deck.id, 0),
            status=status,
        ))
    return responses


@router.post("/", response_model=DeckResponse)
def create_deck(payload: DeckCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = Deck(name=payload.name.strip(), target_size=payload.target_size, description=payload.description, user_id=current_user.id)
    if not deck.name:
        raise HTTPException(status_code=422, detail="Deck name is required")
    db.add(deck)
    db.commit()
    db.refresh(deck)
    return _deck_response(deck)


@router.get("/{deck_id}", response_model=DeckResponse)
def get_deck(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    owned_quantities = _owned_quantities(db, current_user.id, [entry.card_id for entry in deck.entries])
    return _deck_response(deck, owned_quantities)


@router.patch("/{deck_id}", response_model=DeckResponse)
def update_deck(deck_id: int, payload: DeckUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    if payload.name is not None:
        deck.name = payload.name.strip()
        if not deck.name:
            raise HTTPException(status_code=422, detail="Deck name is required")
    if payload.target_size is not None:
        deck.target_size = payload.target_size
    fields_set = getattr(payload, "model_fields_set", None)
    if fields_set is None:
        fields_set = payload.__fields_set__
    if "description" in fields_set:
        deck.description = payload.description
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(deck)
    owned_quantities = _owned_quantities(db, current_user.id, [entry.card_id for entry in deck.entries])
    return _deck_response(deck, owned_quantities)


@router.delete("/{deck_id}")
def delete_deck(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    db.delete(deck)
    db.commit()
    return {"message": "Deck deleted"}


@router.post("/{deck_id}/entries", response_model=DeckResponse)
def add_deck_entry(deck_id: int, payload: DeckEntryCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    entry = next((entry for entry in deck.entries if entry.card_id == payload.card_id), None)
    if entry:
        entry.required_quantity += payload.required_quantity
    else:
        card = db.query(Card).filter(Card.id == payload.card_id).first()
        if not card:
            raise HTTPException(status_code=404, detail="Card not found")
        if card.is_custom and card.custom_owner_id != current_user.id:
            raise HTTPException(status_code=404, detail="Card not found")
        if not _owned_quantities(db, current_user.id, [payload.card_id]).get(payload.card_id):
            raise HTTPException(status_code=422, detail="Add cards you own to a new deck entry")
        entry = DeckEntry(deck_id=deck.id, card_id=card.id, required_quantity=payload.required_quantity)
        db.add(entry)
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.patch("/{deck_id}/entries/{entry_id}", response_model=DeckResponse)
def update_deck_entry(deck_id: int, entry_id: int, payload: DeckEntryUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    entry = db.query(DeckEntry).filter(DeckEntry.id == entry_id, DeckEntry.deck_id == deck.id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Deck entry not found")
    entry.required_quantity = payload.required_quantity
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.delete("/{deck_id}/entries/{entry_id}", response_model=DeckResponse)
def delete_deck_entry(deck_id: int, entry_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    entry = db.query(DeckEntry).filter(DeckEntry.id == entry_id, DeckEntry.deck_id == deck.id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Deck entry not found")
    db.delete(entry)
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)
