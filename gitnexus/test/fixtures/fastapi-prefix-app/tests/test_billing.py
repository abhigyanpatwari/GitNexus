# A test app mounts the router bare; production mounts it at /billing.
from fastapi import FastAPI
from app_pkg import billing

app = FastAPI()
app.include_router(billing.router)
