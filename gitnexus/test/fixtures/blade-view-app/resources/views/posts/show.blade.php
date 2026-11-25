@extends('layouts/app')

@section('content')
    @includeFirst(['posts.custom-header', 'partials.promo'])
    @include('mail::message')
@endsection
