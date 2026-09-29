from fastapi import FastAPI
from . import billing

app = FastAPI()
app.include_router(billing.router, prefix="/billing")
