package User;
use strict;
use warnings;

sub new {
    my ($class, $name, $email) = @_;
    my $self = {
        name => $name || '',
        email => $email || '',
        id => int(rand(10000))
    };
    return bless $self, $class;
}

sub save {
    my $self = shift;
    print "Saving user: " . $self->{name} . " (" . $self->{email} . ")\n";
    return 1;
}

sub load {
    my ($class, $id) = @_;
    print "Loading user with ID: $id\n";
    return $class->new("Loaded User", "loaded\@example.com");
}

sub get_name {
    my $self = shift;
    return $self->{name};
}

sub set_email {
    my ($self, $email) = @_;
    $self->{email} = $email;
}

1;