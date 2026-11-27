@extends('layouts.app')

@section('content')
    <x-alert>
        <x-slot name="title">Heads up</x-slot>
        New posts are in.
    </x-alert>
    <x-forms.input name="search" />

    @includeWhen($showPromo, 'partials.promo')
    @includeIf('partials.missing')
    @include($dynamicView)
    @@include('partials.nav')
    {{-- @include('partials.old') --}}

    <ul>
        @each('posts.row', $posts, 'post')
    </ul>
@endsection
