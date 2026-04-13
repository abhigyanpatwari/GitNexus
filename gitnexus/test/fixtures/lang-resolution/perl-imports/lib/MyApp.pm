package MyApp;
use strict;
use warnings;
use Utils::Logger;

sub new {
    my $class = shift;
    my $self = {
        logger => Utils::Logger->new()
    };
    return bless $self, $class;
}

sub run {
    my $self = shift;
    $self->{logger}->log("MyApp is running");
    $self->process_data();
}

sub process_data {
    my $self = shift;
    $self->{logger}->debug("Processing data...");
}

1;