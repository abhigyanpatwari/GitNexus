package DataProcessor;
use strict;
use warnings;

sub new {
    my $class = shift;
    return bless {}, $class;
}

sub process_data {
    my ($self, $data) = @_;
    print "Processing data: $data\n";
    return uc($data);
}

sub validate_format {
    my ($self, $data) = @_;
    return $data =~ /^\w+$/;
}

1;