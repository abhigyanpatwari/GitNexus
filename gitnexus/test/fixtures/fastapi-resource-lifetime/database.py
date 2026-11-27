from storage import open_session


async def request_session():
    session = open_session()
    try:
        yield session
    finally:
        await session.close()


async def managed_session():
    async with open_session() as session:
        yield session


def borrowed_session():
    return open_session()


async def unrelated_cleanup(other):
    session = open_session()
    try:
        yield session
    finally:
        await other.close()


def conditional_cleanup(enabled):
    session = open_session()
    try:
        yield session
    finally:
        if enabled:
            session.close()
