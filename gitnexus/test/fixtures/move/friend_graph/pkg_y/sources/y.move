module pkg_y::m_y {
    friend pkg_x::m_x;

    public(friend) fun peek(): u64 {
        pkg_x::m_x::secret()
    }
}
