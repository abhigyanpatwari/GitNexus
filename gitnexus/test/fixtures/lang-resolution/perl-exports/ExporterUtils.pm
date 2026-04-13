package Exporter::Utils;
use strict;
use warnings;
use Exporter 'import';

our @EXPORT = qw(exported_function always_available);
our @EXPORT_OK = qw(optional_function);

sub exported_function {
    my $data = shift;
    print "Exported function called with: $data\n";
    return process_internal($data);
}

sub always_available {
    return "Always available function";
}

sub optional_function {
    return "Optional export function";
}

sub process_internal {
    my $data = shift;
    return "Processed: $data";
}

1;