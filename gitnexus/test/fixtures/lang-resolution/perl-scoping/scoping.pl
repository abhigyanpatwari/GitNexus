#!/usr/bin/perl
use strict;
use warnings;

my $global_var = "global";

sub outer_function {
    my $outer_var = "outer";
    
    my $closure = sub {
        my $inner_var = "inner";
        print "$global_var, $outer_var, $inner_var\n";
        inner_function($inner_var);
    };
    
    return $closure;
}

sub inner_function {
    my $param = shift;
    print "Inner function received: $param\n";
}

sub main {
    my $closure = outer_function();
    $closure->();
}

main();