from fastapi import Depends, FastAPI
from database import borrowed_session, managed_session, request_session

app = FastAPI()


def on_commit():
    pass


@app.get("/studies")
def studies(session=Depends(request_session)):
    session.add_listener(on_commit)


@app.get("/managed")
def managed(session=Depends(managed_session)):
    session.add_listener(on_commit)


@app.get("/borrowed")
def borrowed(session=Depends(borrowed_session)):
    session.add_listener(on_commit)
