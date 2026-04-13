package Utils::Logger;
use strict;
use warnings;

sub new {
    my $class = shift;
    my $self = {
        level => 'INFO'
    };
    return bless $self, $class;
}

sub log {
    my ($self, $message) = @_;
    print "[" . localtime() . "] $message\n";
}

sub debug {
    my ($self, $message) = @_;
    print "[DEBUG] $message\n" if $self->{level} eq 'DEBUG';
}

1;