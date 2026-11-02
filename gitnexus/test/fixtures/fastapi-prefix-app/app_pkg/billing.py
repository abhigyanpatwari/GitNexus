from fastapi import APIRouter

router = APIRouter()


@router.get("/invoices")
async def list_invoices():
    return []
