#!/usr/bin/perl
use strict;
use warnings;
use DataProcessor;
use Validator;

sub main {
    my $processor = DataProcessor->new();
    
    # Package-qualified call
    my $result = DataProcessor::process_data($processor, "hello world");
    
    # Imported function call (from @EXPORT)
    if (validate_input($result)) {
        print "Input is valid: $result\n";
    }
    
    # Direct method call
    if ($processor->validate_format($result)) {
        print "Format is valid\n";
    }
}

main();