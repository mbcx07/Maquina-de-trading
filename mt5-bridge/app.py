from main import app
from market_routes import router as market_router

app.include_router(market_router)
