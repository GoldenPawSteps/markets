# app/routers/auth.py
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from .. import models, schemas
from ..database import get_db
from ..config import settings
from ..security import hash_password, verify_password, create_access_token, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=schemas.Token)
async def register(body: schemas.RegisterBody, db: AsyncSession = Depends(get_db)):
    exists = (await db.execute(select(models.User).where(models.User.name == body.name))).scalar_one_or_none()
    if exists:
        raise HTTPException(400, "That name is taken")
    user = models.User(
        name=body.name, email=body.email, hashed_password=hash_password(body.password),
        avatar=body.name[:2].upper(), color="#4f46e5",
        balance=settings.starting_balance, start_balance=settings.starting_balance,
    )
    db.add(user)
    await db.commit()
    return schemas.Token(access_token=create_access_token(user.id))


@router.post("/login", response_model=schemas.Token)
async def login(form: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(models.User).where(models.User.name == form.username))).scalar_one_or_none()
    if not user or not user.hashed_password or not verify_password(form.password, user.hashed_password):
        raise HTTPException(401, "Incorrect name or password")
    return schemas.Token(access_token=create_access_token(user.id))


@router.get("/me", response_model=schemas.UserOut)
async def me(user: models.User = Depends(get_current_user)):
    return user