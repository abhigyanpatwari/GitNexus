package Test::Module;
use strict;
use warnings;

sub new {
    my $class = shift;
    return bless {}, $class;
}

sub hello {
    my $self = shift;
    print "Hello from Perl!\n";
}

1;
