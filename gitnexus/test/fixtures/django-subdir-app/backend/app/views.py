"""App views referenced by app/urls.py."""
from django.http import JsonResponse


def item_list(request):
    return JsonResponse({'items': []})


def item_detail(request, pk):
    return JsonResponse({'id': pk})
