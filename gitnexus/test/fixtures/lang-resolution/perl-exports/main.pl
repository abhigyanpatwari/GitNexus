#!/usr/bin/perl
use strict;
use warnings;
use Exporter::Utils;
use Exporter::Utils qw(optional_function);

sub main {
    # Call exported function (automatically imported)
    my $result1 = exported_function("test data");
    
    # Call always available function
    my $result2 = always_available();
    
    # Call optionally imported function
    my $result3 = optional_function();
    
    print "Results: $result1, $result2, $result3\n";
}

main();