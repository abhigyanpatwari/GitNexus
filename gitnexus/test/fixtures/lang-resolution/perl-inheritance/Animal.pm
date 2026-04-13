package Animal;
use strict;
use warnings;

sub new {
    my ($class, $name) = @_;
    my $self = {
        name => $name || 'Unknown'
    };
    return bless $self, $class;
}

sub speak {
    my $self = shift;
    print $self->{name} . " makes a sound\n";
}

sub get_name {
    my $self = shift;
    return $self->{name};
}

1;