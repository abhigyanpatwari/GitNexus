package Dog;
use strict;
use warnings;
use parent 'Animal';

sub new {
    my ($class, $name, $breed) = @_;
    my $self = $class->SUPER::new($name);
    $self->{breed} = $breed || 'Mixed';
    return $self;
}

sub bark {
    my $self = shift;
    print $self->{name} . " barks: Woof!\n";
    $self->speak(); # Call parent method
}

sub get_breed {
    my $self = shift;
    return $self->{breed};
}

1;