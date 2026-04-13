#!/usr/bin/perl
use strict;
use warnings;
use Test::Module;

sub main {
    my $obj = Test::Module->new();
    $obj->hello();
}

main();
