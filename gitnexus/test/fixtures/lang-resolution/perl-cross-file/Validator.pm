package Validator;
use strict;
use warnings;
use Exporter 'import';

our @EXPORT = qw(validate_input);

sub validate_input {
    my $input = shift;
    return defined($input) && length($input) > 0;
}

sub validate_email {
    my $email = shift;
    return $email =~ /^\S+\@\S+\.\S+$/;
}

1;