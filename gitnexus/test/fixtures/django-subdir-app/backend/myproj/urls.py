"""Root URL conf — a root-level route plus an include() into the app."""
from django.urls import path, include

from . import views

urlpatterns = [
    path('health/', views.health, name='health'),
    path('api/', include('app.urls')),
]
